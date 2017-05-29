const ld = require('lodash')
const Promise = require('bluebird')
const Ajv = require('ajv')

const ajv = new Ajv({
  coerceTypes: 'array',
  useDefaults: true
})
const regExpAll = /.*/
const areHeadersValid = ajv.compile({
  type: 'object',
  properties: {
    id: {
      type: 'string'
    },
    timeout: {
      type: 'number'
    },
    slow: {
      type: 'number'
    },
    local: {
      type: 'boolean'
    },
    nowait: {
      type: 'boolean'
    },
    notify: {
      type: 'array',
      items: {
        type: 'string',
      },
      minItems: 1,
      uniqueItems: true
    }
  }
})

/**
 * Send bishop pattern execution event to all listeners
 */
function notifyListenersAboutEvent({ message, headers}, transports, globalEmitter) {
  if (!headers.notify) { return }
  if (headers.notify.includes('local')) {
    const uniqueEvent = `${routingKeyFromPattern(headers.pattern, '#').join('.')}`
    globalEmitter.emit(uniqueEvent, message, headers)
  }

  return Promise.map(headers.notify, transportName => {
    if (transportName === 'local') { return }
    const notifyTransportSubscribers = transports[transportName].notify
    return notifyTransportSubscribers(message, headers)
  })
}

function calcDelay(offset, inNanoSeconds = true) {
  const now = (() => {
    if (inNanoSeconds) {
      const [ seconds, nanoseconds ] = process.hrtime()
      return seconds * 1e9 + nanoseconds
    }
    return new Date().getTime()
  })()
  return offset ? now - offset : now
}

// 'model:comments, target, action:create' => { model: 'comments', target: /.*/, action: 'create' }
function text2obj(input) {
  const output = input.split(',').reduce((prev, cur) => {
    let [ key, value ] = cur.trim().split(':')
    if (typeof value === 'undefined') {
      value = regExpAll.toString()
    }
    const trimmedValue = value.trim()
    prev[key.trim()] = trimmedValue[0] === '/' ?
      new RegExp(trimmedValue.slice(1, -1)) :
      trimmedValue
    return prev
  }, {})
  return output
}

function ensureIsFuction(func, message = 'function expected') {
  if (!func || !ld.isFunction(func)) {
    throw new Error(message)
  }
  return func
}

function objectify(obj) {
  return ld.isString(obj) ? text2obj(obj) : ld.cloneDeep(obj)
}

// split all patterns into one, extract payload and meta info from it
function split(...args) {
  const meta = {}
  const message = {}
  const raw = {}
  args.forEach(item => {
    const partialPattern = objectify(item)
    for (let field in partialPattern) {
      if (field[0] === '$') { // meta info like $timeout, $debug etc
        meta[field.substring(1)] = partialPattern[field]
      } else {
        message[field] = partialPattern[field]
      }
      raw[field] = partialPattern[field]
    }
  })
  return [ message, meta, raw ]
}

function beautify(obj) {
  return ld.keys(obj).map(key => {
    const value = obj[key]
    if (ld.isPlainObject(value)) {
      return `${key}:{${ld.keys(value).join(',')}}`
    }
    return value ? `${key}:${value.toString()}` : key
  }).join(', ')
}

// convert object { qwe: 'aaa', asd: 'bbb'} to string 'qwe.aaa.asd.bbb' with sorted keys
function routingKeyFromPattern(pattern, replaceWild = '*') {
  return Object.keys(pattern).sort().map(key => {
    const keyType = typeof pattern[key]
    const value = keyType === 'string' ? pattern[key] : replaceWild
    return `${key}.${value}`
  })
}

function uniqueId() {
  return ld.sampleSize('abcdefghigklmnopqrstuvwxyz1234567890', 10).join('')
}

module.exports = {

  calcDelay, ensureIsFuction, objectify, split, beautify, routingKeyFromPattern,

  registerRemoteTransport(remoteTransportsStorage, name, wrapper, options = {}) {
    if (remoteTransportsStorage[name]) {
      throw new Error(`.register(remote): ${name} already exists`)
    }
    remoteTransportsStorage[name] = { options, wrapper }
  },

  registerTransport(transportsStorage, name, transportMethods, options = {}) {
    if (transportsStorage[name]) {
      throw new Error(`.register(transport): ${name} already exists`)
    }
    transportsStorage[name] = Object.assign({}, transportMethods, { options })
  },

  registerInMatcher(matcher, message, payload) {
    const [ pattern, options ] = ld.isArray(message) ? message : split(message)
    matcher.add(pattern, [ payload, options ])
  },

  registerGlobal(globalQueue, payload) {
    globalQueue.push([ payload, {} ])
  },

  throwIfPatternExists(matcher, pattern) {
    const foundPattern = matcher.lookup(pattern, { patterns: true })
    if (ld.isEqual(foundPattern, pattern)) {
      throw new Error(`.add: .forbidSameRouteNames option is enabled, and pattern already exists: ${beautify(pattern)}`)
    }
  },

  createPayloadWrapper(payload, headers, remoteTransportsStorage) {
    if(headers.local || ld.isFunction(payload)) { // this method found in local patterns
      return [ payload, {} ]
    }
    // thereis a string in payload - redirect to external transport
    const { request, options } = remoteTransportsStorage[payload] || {}
    if (!request) {
      throw new Error(`transport ${payload} has no .request method`)
    }
    if (options.timeout && !headers.timeout) { // redefine pattern timeout if transport-specific is set
      headers.timeout = options.timeout
    }
    return [ request, {} ]
  },

  createSlowExecutionWarner(slowTimeoutWarning, userTime, headers, logger) {
    const actStarted = userTime || calcDelay(null, false)
    return message => {
      const executionTime = calcDelay(actStarted, false)
      if (executionTime > slowTimeoutWarning) {
        logger.warn(`pattern executed in ${executionTime}ms: ${beautify(headers.source)}`)
      }
      return message
    }
  },

  normalizeHeaders({addHeaders, actHeaders, sourceMessage, matchedPattern}) {
    const headers = ld.merge({}, addHeaders, actHeaders, {
      pattern: matchedPattern,
      source: sourceMessage
    })
    if (!headers.id) {
      headers.id = uniqueId()
    }

    // true, 'true', 'name1, name2', ['name1', 'name2']
    // by default, local notification is enabled
    if (headers.notify && !ld.isArray(headers.notify)) {
      switch (headers.notify) {
        case true:
        case 'true':
          headers.notify = ['local']
          break
        default:
          if (headers.notify instanceof RegExp) {
            headers.notify = ['local']
          } else {
            headers.notify = headers.notify.split(',').map(item => item.trim()).filter(item => item)
          }
      }
    }

    if (!areHeadersValid(headers)) { // should append defaults, convert values into valid ones etc
      throw new Error(ajv.errorsText(areHeadersValid.errors))
    }
    return headers
  },

  // create cancelable promise from chain of payloads
  createChainRunnerPromise({ executionChain, pattern, headers, errorHandler, globalEmitter, transports, log }) {
    // NOTE: `headers` can be modified by chain item
    return () => {
      return Promise.reduce(executionChain, (input, chainItem) => {
        const [ handlerAsync ] = chainItem
        if (headers.break) { // should break execution and immediately return result
          const error = new Promise.CancellationError('$break found')
          error.message = input
          error.headers = headers
          throw error
        }
        return handlerAsync(input, headers)
      }, pattern)
      .then(message => {
        return { message, headers }
      })
      .then(async data => {
        if (data.headers.notify) {
          // notify listeners in async mode without block
          notifyListenersAboutEvent(data, transports, globalEmitter).catch(err => {
            log.error(err)
          })
        }
        return data
      })
      .catch(Promise.CancellationError, err => { // stop execution chain if `break` event raised
        const { message, headers } = err
        return { message, headers }
      })
      .catch(err => {
        return { message: errorHandler(err), headers }
      })
    }
  }
}
