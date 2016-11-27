const bloomrun = require('bloomrun')
const ld = require('lodash')
const { objectify, runMethodsParallel } = require('./utils')
const Promise = require('bluebird')


// default options for bishop instance
const defaultConfig = {
  //  if set to insertion, it will try to match entries in insertion order
  //  if set to depth, it will try to match entries with the most properties first
  matchOrder: 'insertion', // insertion, depth
  // default timeout for pattern execution in ms
  timeout: 500,
  // handle only user errors by default and fall down on others
  // example: ReferenceError, RangeError, SyntaxError, TypeError, Error, ...
  // own sync function can be passed
  terminateOn: ['ReferenceError', 'RangeError', 'SyntaxError', 'TypeError'],
  // logger options for 'pino' logger: https://www.npmjs.com/package/pino#pinoopts-stream
  // own logger instance can be passed here, should support at lease: 'debug, info, warn, error'
  log: {
    name: 'bishop'
  }
}

const Bishop = (_config = {}) => {

  const config = ld.assign({}, defaultConfig, _config)

  // set passed logger instance, or create 'pino' logger with passed options
  const logger = ld.isPlainObject(config.log)
    ? require('pino')(ld.clone(config.log))
    : config.log

  // create two pattern matchers: matcher with all patterns (local + network), and local only
  const pm = bloomrun({ indexing: config.matchOrder })
  const pmLocal = bloomrun({ indexing: config.matchOrder })

  // check if error should be passed to caller instead of throwing
  const errorHandler = ld.isFunction(config.terminateOn) ? config.terminateOn : err => {
    if (config.terminateOn.includes(err.name)) {
      this.log.fatal(err)
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
      const type = ld.isFunction(handler) ? 'local' : handler
      const pattern = objectify(_pattern)
      const payload = { type, handler }

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
    // $local - search only in local patterns, skip remote transporting
    // $nowait - resolve immediately (in case of local patters), or then message is sent (in case of transports)
    async act(_pattern, payload = {}) {

      if (!_pattern) { throw new Error('pattern not specified') }
      const pattern = ld.assign({}, objectify(_pattern), payload)

      const matchResult = (pattern.$local ? pmLocal : pm).lookup(pattern)
      if (!matchResult) {
        throw new Error(`pattern not found: ${JSON.stringify(pattern)}`)
      }

      const { type, handler } = matchResult
      const isLocalPattern = type === 'local'

      let method
      if (isLocalPattern) {
        method = handler
      } else {
        // wrap with network call
        if (!this.transport[type] || !this.transport[type].send) {
          throw new Error(`transport "${type}" not exists`)
        }
        method = this.transport[type].send
      }

      const executor = isLocalPattern && pattern.$nowait ? (...input) => {
        Promise.resolve(method(...input)).catch(err => {
          // in case of local pattern - resolve immediately and emit error on fail
          // in case of transports - they should respect $nowait flag and emit errors manually
          const muteError = errorHandler(err)
          if (!muteError) { this.log.error(err) }
        })
        return Promise.resolve()
      }: (...input) => {
        return Promise.resolve(method(...input)).catch(err => {
          const muteError = errorHandler(err)
          if (!muteError) { throw err }
        })
      }

      const timeout = pattern.$timeout || this.timeout

      if (!timeout) {
        return executor(pattern)
      }
      return Promise
        .resolve(executor(pattern))
        .timeout(timeout)
        .catch(Promise.TimeoutError, () => {
          throw new Error(`pattern timeout after ${timeout}ms: ${JSON.stringify(pattern)}`)
        })
    },

    // load plugin, module etc
    async use(...input) {
      const [ path, ...params ] = input
      const plugin = ld.isString(path) ? require(path) : path
      if (!ld.isFunction(plugin)) { throw new Error(`unable to load plugin: function expected, but ${plugin} found`) }

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
      await runMethodsParallel(this.transport, 'connect')
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
