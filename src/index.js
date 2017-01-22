const bloomrun = require('bloomrun')
const ld = require('lodash')
const { objectify, runMethodsParallel, isFunction, createDebugger, calcDelay, requirePlugin } = require('./utils')
const Promise = require('bluebird')

// default options for bishop instance
const defaultConfig = {
  forbidSameRouteNames: false,
  //  if set to insertion, it will try to match entries in insertion order
  //  if set to depth, it will try to match entries with the most properties first
  matchOrder: 'depth', // insertion, depth
  // default timeout for pattern execution in ms
  timeout: 500,
  // append debbuging information into response
  debug: false,
  // emit warning on slow execution in ms
  slowPatternTimeout: null,
  // handle only user errors by default and fall down on others
  // example: ReferenceError, RangeError, SyntaxError, TypeError, Error, ...
  // own sync function can be passed
  terminateOn: ['ReferenceError', 'RangeError', 'SyntaxError', 'TypeError']
}

const Bishop = (_config = {}, logger = console) => {
  const config = ld.assign({}, defaultConfig, _config)

  // create two pattern matchers: matcher with all patterns (local + network), and local only
  const pm = bloomrun({ indexing: config.matchOrder })
  const pmLocal = bloomrun({ indexing: config.matchOrder })

  // check if error should be passed to caller instead of throwing
  const errorHandler = isFunction(config.terminateOn) ? config.terminateOn : err => {
    if (config.terminateOn.includes(err.name)) {
      logger.error(err)
      process.exit(1)
    }
    // falsy - handle error (return to sender, emit message etc)
    // truthy - mute error (ex: error already logged)
    return false
  }

  return {

    timeout: config.timeout,

    // default logger for bishop instances
    log: logger,

    // keep all named routes here
    routes: {},

    // loaded remote connectors for further usage
    transport: {},

    // append handler for route (local or remote)
    // .add(route, function) // execute local payload
    // .add(route, 'transportname') // execute payload using transport
    add(_pattern, handler) {

      const type = isFunction(handler) ? 'local' : handler
      const pattern = objectify(_pattern)
      const payload = { type, handler }

      if (config.forbidSameRouteNames) { // ensure same route not yet exists
        const foundPattern = pm.lookup(pattern, { patterns: true })
        if(ld.isEqual(foundPattern, pattern)) {
          throw new Error(`.forbidSameRouteNames option is enabled, and pattern already exists: ${JSON.stringify(pattern)}`)
        }
      }

      pm.add(pattern, payload)
      if (type === 'local') {
        pmLocal.add(pattern, payload)
      }
    },

    remove(_pattern) {
      pm.remove(objectify(_pattern))
      pmLocal.remove(objectify(_pattern))
    },

    // $timeout - redefine global request timeout for network requests
    // $slow - emit warning if pattern executing more than $slow ms
    // $local - search only in local patterns, skip remote transporting
    // $nowait - resolve immediately (in case of local patters), or then message is sent (in case of transports)
    // $debug - append debug information into log output
    async act() {
      const patternStarted = calcDelay(null, false)
      const [ _pattern, ...payloads ] = arguments
      if (!_pattern) { throw new Error('pattern not specified') }
      const pattern = ld.assign({}, objectify(_pattern), ...payloads)
      const slowTimeout = config.slowPatternTimeout || pattern.$slow
      const timeout = pattern.$timeout || this.timeout
      const isDebugEnabled = pattern.$debug || config.debug
      const debugStorage = {}
      const debug = createDebugger({ enabled: isDebugEnabled, logger }, debugStorage)
      debug.track('finished')
      debug.push('source pattern found', pattern)

      const matchResult = (pattern.$local ? pmLocal : pm).lookup(pattern, {
        patterns: true,
        payloads: true
      })
      if (!matchResult) {
        throw new Error(`pattern not found: ${JSON.stringify(pattern)}`)
      }

      debug.push('resulting pattern found', pattern)
      const { type, handler } = matchResult.payload
      debug.push('pattern matched', matchResult.pattern)

      const isLocalPattern = type === 'local'

      let method
      if (isLocalPattern) {
        method = handler
        debug.push('transport selected', 'local')
      } else {
        // wrap with network call
        if (!this.transport[type] || !this.transport[type].send) {
          throw new Error(`transport "${type}" not exists`)
        }
        debug.push('transport selected', type)
        method = this.transport[type].send
      }

      const doPostOperations = () => {
        if (slowTimeout) {
          const executionTime = calcDelay(patternStarted, false)
          if (executionTime > slowTimeout) {
            this.log.warn(`pattern executed in ${executionTime}ms: ${JSON.stringify(pattern)}`)
          }
        }
        debug.trackEnd('finished')
      }
      const executor = isLocalPattern && pattern.$nowait ? (...input) => {
        debug.push('local nowait behaviour selected')
        Promise.resolve(method(...input)).catch(err => {
          // in case of local pattern - resolve immediately and emit error on fail
          // in case of transports - they should respect $nowait flag and emit errors manually
          const muteError = errorHandler(err)
          if (!muteError) { this.log.error(err) }
        })
        // append debugin information to empty response
        const response = isDebugEnabled ? debugStorage : undefined
        doPostOperations()
        return Promise.resolve(response)
      }: async (...input) => {
        debug.track('pattern method run')
        let result = null
        try {
          result = await method(...input)
          debug.trackEnd('pattern method run', 'success')
        } catch (err) {
          const muteError = errorHandler(err)
          debug.trackEnd('pattern method run', `fail: ${err.message}, muted: ${muteError}`)
          if (!muteError) { throw err }
        }
        doPostOperations()
        return ld.isObject(result) ? ld.assign(result, debugStorage) : result
      }

      if (!timeout) {
        return executor(pattern)
      }
      return Promise
        .resolve(executor(pattern))
        .timeout(timeout)
        .catch(Promise.TimeoutError, () => {
          debug.push('timeout error')
          throw new Error(`pattern timeout after ${timeout}ms: ${JSON.stringify(pattern)}`)
        })
    },

    // load plugin, module etc
    async use(...input) {
      const [ path, ...params ] = input
      const plugin = requirePlugin(path)
      if (!isFunction(plugin)) { throw new Error('unable to load plugin: function expected, but not found') }
      const data = await plugin(this, ...params)
      if (!data) { return } // this plugin dont return any suitable data

      const { name, routes } = data

      switch (data.type) {

        case 'transport': // transport connection
          if (!name) { throw new Error('transport plugins should return .name property') }
          this.transport[name] = data
          break

        default: // plugin with business logic
          if (name && routes) {
            this.routes[name] = this.routes[name] || {}
            ld.assign(this.routes[name], routes)
          }
      }
      return data
    },

    // connect to all remote instances
    async connect() {
      await runMethodsParallel(this.transport, 'connect')
    },

    // disconnect from all remote instances
    async disconnect() {
      await runMethodsParallel(this.transport, 'disconnect')
    },

    // listen all transports
    async listen() {
      await runMethodsParallel(this.transport, 'listen')
    },

    // disconnect from all transports
    async close() {
      await runMethodsParallel(this.transport, 'close')
    }
  }
}

module.exports = Bishop
