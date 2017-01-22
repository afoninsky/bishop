const server = require('../src')()
const client = require('../src')()

server.add({ role: 'test', command: 'echo' }, data => data)
client.add({ role: 'test' }, 'http-client')

;(async () => {
  try {
    await server.use('bishop-transport-http', {
      name: 'http-server'
    })
    await client.use('bishop-transport-http', {
      name: 'http-client'
    })
    await server.listen()
    const result = await client.act({ role: 'test', command: 'echo' }, { some: 'else'})
    console.log('answer:')
    console.log(result)
    await server.close()
  } catch (err) {
    console.log(err)
  }
})()
