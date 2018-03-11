#!/usr/bin/env node

'use strict'

// //////////////////////////////////////////////////////
// constant
// //////////////////////////////////////////////////////
const SerialPort = require('serialport')
const express = require('express')
const web = express()
const WebSocket = require('ws')
const fs = require('fs')
const path = require('path')
const Matrix = require('./inc/matrix')
const config = require('./config')[process.env.NODE_ENV === 'production' ? 'production' : 'development']

// //////////////////////////////////////////////////////
// variables
// //////////////////////////////////////////////////////
var clients = []
var connectedClients = 0
var script
var wss
var serialPort = new SerialPort('/dev/ttyUSB0', {
  baudRate: 115200,
  autoOpen: false
})

// //////////////////////////////////////////////////////
// main script
// //////////////////////////////////////////////////////
init()

// //////////////////////////////////////////////////////
// core functions
// //////////////////////////////////////////////////////
function init () {
  // SERIAL
  serialPort.on('open', () => {
    serialPort.on('data', (data) => {
      if (data === 'ready') {
        log('Serial: connected')
        Matrix.connected = true
      }
    })
  })

  serialPort.on('close', () => {
    log('Serial: closed')
    Matrix.connected = false
    connectSerial()
  })

  // open errors will be emitted as an error event
  serialPort.on('error', (err) => {
    log('Serial Error: ' + err.message)
  })

  connectSerial()

  // Matrix
  Matrix.init(config.matrix.size)
  Matrix.onSystem('broadcastLed', broadcastLed)
  Matrix.onSystem('showLeds', showLeds)

  // Express (static web files)
  web.use(express.static(path.join(__dirname, config.web.root)))
  web.get('/load.js', function (req, res) {
    res.set('Content-Type', 'text/javascript')
    res.send('socket = connectWebsocket("' +
      config.web.websocket.address + '")'
    )
  })
  web.listen(config.web.port)

  // WebSocket
  wss = new WebSocket.Server({ port: config.web.websocket.port })
  wss.on('connection', (ws) => {
    let id = connectedClients
    startWebSocket(id, ws)

    ws.on('message', (msg) => {
      parseWebSocket(id, ws, msg)
    })
    ws.on('close', (code, reason) => {
      closeWebSocket(id, ws)
    })
    ws.on('error', (e) => {
      ws.terminate()
    })
    ws.on('pong', () => {
      ws.isAlive = true
    })
  })

  // WebSocket keep a live pings
  setInterval(() => {
    wss.clients.forEach(function each (ws) {
      if (ws.isAlive === false) return ws.terminate()
      ws.isAlive = false
      ws.ping(() => {})
    })
  }, 30000)

  console.log('LED Server 0.2')
  console.log('Webinterface: port ' + config.web.websocket.port)
  console.log('Websocket: port ' + config.web.port)

  if (config.scripts.autoStart) {
    launchScript(config.scripts.autoStart)
  }
}

function broadcastLed (id, rgb) {
  wss.clients.forEach(function each (ws) {
    if (ws.authenticated) {
      sendWebSocket(ws, {
        'type': 'led',
        'id': id,
        'rgb': rgb
      })
    }
  })
  if (Matrix.connected) {
    let x = Math.floor(id / Matrix.size)
    let y = id % Matrix.size
    if (y % 2 === 0) {
      x = Matrix.size - x - 1
    }
    id = (y * Matrix.size + x)
    id = id < 10 ? '00' + id : (id < 100) ? '0' + id : id
    var data = id + ':' + Matrix.RGB_TO_STRING(rgb)
    serialPort.write(data, 'binary', (err) => {
      if (err) {
        log('Serial Error: ' + err.message)
      }
    })
  }
}

function showLeds () {
  if (Matrix.connected) {
    // mqttClient.publish(config.mqtt.topic, 'show')
    serialPort.write('show', 'binary', (err) => {
      if (err) {
        log('Serial Error: ' + err.message)
      }
    })
  }
}

// //////////////////////////////////////////////////////
// Serial functions
// //////////////////////////////////////////////////////
function connectSerial () {
  serialPort.open((err) => {
    if (err) {
      setTimeout(connectSerial, 1000)
    }
  })
}

// //////////////////////////////////////////////////////
// WebSocket functions
// //////////////////////////////////////////////////////
function startWebSocket (id, ws) {
  console.log('WebSocket: new connection')
  clients[id] = ws
  ws.authenticated = false
  connectedClients++

  sendWebSocket(ws, {
    'type': 'status',
    'status': Matrix.connected
  })
  sendWebSocket(ws, {
    'type': 'script',
    'script': script ? script.id : null
  })
  if (script) {
    // TODO: send script info, inputs, ...
  } else {
    listScripts((files) => {
      sendWebSocket(ws, {
        'type': 'scripts',
        'scripts': files
      })
    })
  }
  if (config.auth.autoLogin) {
    authWebsocket(ws, true)
  }
}

function closeWebSocket (id, ws) {
  ws.terminate()
  delete clients[id]
  connectedClients--
  console.log('WebSocket: connection closed')
}

function parseWebSocket (id, ws, msg) {
  let data
  try {
    data = JSON.parse(msg)
  } catch (e) {
  }

  if (ws.authenticated === true) {
    switch (data.type) {
      case 'logout':
        authWebsocket(ws, false)
        return
      case 'launch_script':
        launchScript(data.script)
        return
      case 'stop_script':
        stopScript()
        return
    }
  }

  switch (data.type) {
    case 'login':
      if (data.password === config.auth.password || config.auth.password === null) {
        authWebsocket(ws, true)
      } else {
        // TODO: auth failed
      }
      break
    case 'authenticated':
      sendWebSocket(ws, {
        'type': 'authenticated',
        'auth': ws.authenticated
      })
      break
    case 'input':
      if (script) {
        script.input(data.event)
      }
      break
    default:
      console.log('< ' + msg)
      break
  }
}

function sendWebSocket (ws, data) {
  if (ws.readyState === ws.OPEN) {
    var raw = JSON.stringify(data)
    ws.send(raw)
  }
}

function authWebsocket (ws, auth) {
  ws.authenticated = auth
  sendWebSocket(ws, {
    'type': 'auth',
    'auth': ws.authenticated
  })
  // send all leds
  if (ws.authenticated && script) {
    let leds = Matrix.toArray()
    for (let i = 0; i < leds.length; i++) {
      broadcastWebSocket({
        'type': 'led',
        'id': i,
        'rgb': leds[i]
      })
    }
  }
}

function broadcastWebSocket (data) {
  wss.clients.forEach(function each (ws) {
    sendWebSocket(ws, data)
  })
}

// //////////////////////////////////////////////////////
// Script functions
// //////////////////////////////////////////////////////
function listScripts (cb) {
  let dir = path.join(__dirname, config.scripts.path)
  fs.readdir(dir, function (e, files) {
    if (e) {
      console.error(e)
    }
    cb(files)
  })
}

function launchScript (scriptName) {
  if (script) {
    stopScript()
  }
  try {
    script = require(path.join(__dirname, config.scripts.path, scriptName))
    script.id = scriptName
    script.init(Matrix)
    Matrix.start()
    broadcastWebSocket({
      'type': 'script',
      'script': script.id
    })
  } catch (e) {
    log(e)
  }
}

function stopScript () {
  if (script) {
    let id = script.id
    Matrix.stop()
    script = null
    delete require.cache[path.join(__dirname, config.scripts.path, id)]
    // TODO: unregister event listeners correctly
    broadcastWebSocket({
      'type': 'script',
      'script': null
    })
    listScripts((files) => {
      broadcastWebSocket({
        'type': 'scripts',
        'scripts': files
      })
    })
  }
}

// //////////////////////////////////////////////////////
// Helper functions
// //////////////////////////////////////////////////////
function log (msg) {
  console.log(msg)
  broadcastWebSocket({
    'type': 'log',
    'log': msg
  })
}
