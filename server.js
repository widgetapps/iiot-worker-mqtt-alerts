'use strict';

require('./init')();

console.log('Version: ' + process.version);

let config = require('./config'),
    mongoose = require('mongoose'),
    _ = require('lodash'),
    mqtt = require('mqtt'),
    cbor = require('cbor'),
    Device   = require('@terepac/terepac-models').Device,
    Asset    = require('@terepac/terepac-models').Asset,
    Sensor   = require('@terepac/terepac-models').Sensor;

mongoose.Promise = global.Promise;
// mongoose.set('debug', true);

let conn = mongoose.connection;
conn.on('connecting', function() {
    console.log('Connecting to MongoDB...');
});
conn.on('error', function(error) {
    console.error('Error in MongoDB connection: ' + error);
    mongoose.disconnect();
});
conn.on('connected', function() {
    console.log('Connected to MongoDB.');
});
conn.once('open', function() {
    console.log('Connection to MongoDB open.');
});
conn.on('reconnected', function () {
    console.log('Reconnected to MongoDB');
});
conn.on('disconnected', function() {
    console.log('Disconnected from MongoDB.');
    console.log('DB URI is: ' + config.db);
    mongoose.connect(config.db, config.dbOptions);
});

mongoose.connect(config.db, config.dbOptions);

let client  = mqtt.connect(config.mqtt, config.mqttoptions);
let amqp = require('amqplib').connect(config.amqp);

console.log('Started on IP ' + config.ip + '. NODE_ENV=' + process.env.NODE_ENV);

client.on('error', function (error) {
    console.log('Error connecting to MQTT Server with username ' + config.mqttoptions.username + ' - ' + error);
    process.exit(1);
});

client.on('connect', function () {
    console.log('Connected to MQTT server.');
    // Subscribe to hydrant pubs
    client.subscribe([
        '+/v1/pressure',
        '+/v1/temperature',
        '+/v1/battery',
        '+/v1/rssi',
        '+/gateway/v1/humidity',
        '+/gateway/v1/temperature',
        '+/gateway/v1/vibration'
    ], {qos: 2});
});

client.on('reconnect', function () {
    console.log('Reconnecting to MQTT server...');
});

client.on('close', function () {
    console.log('MQTT connection closed.');
});

client.on('offline', function () {
    console.log('MQTT client went offline.');
});

client.on('message', function (topic, message) {

    let deviceId, source, version, type;
    let topics = topic.split('/');

    if (topics[1] === 'gateway') {
        deviceId = topics[0];
        source = topics[1];
        version = topics[2];
        type = topics[3];

    } else {
        deviceId = topics[0];
        version = topics[1];
        type = topics[2];
    }

    // console.log('Message from device ' + deviceId + ' of type ' + type);

    let validTypes = ['pressure', 'temperature', 'battery', 'rssi', 'humidity', 'vibration'];

    if (!_.includes(validTypes, type)) {
        return;
    }

    let cborOptions ={
        tags: { 30: (val) => {
                return val;
            }
        }
    };

    cbor.decodeFirst(message, cborOptions, function(err, decoded) {

        if (err !== null) {
            console.log('Error decoding CBOR: ' + err);
            return;
        }

        let data = {
            timestamp: decoded.date,
            min: null,
            max: null,
            avg: null,
            point: decoded.value,
            samples: null
        };

        switch (type) {
            case 'pressure':
                data.sensorType = 1;
                break;
            case 'temperature':
                data.sensorType = 2;
                break;
            case 'battery':
                data.sensorType = 4;
                break;
            case 'vibration':
                data.sensorType = 8;
                break;
            case 'humidity':
                data.sensorType = 9;
                break;
            case 'rssi':
                data.sensorType = 10;
                break;
        }
        handleData(data, deviceId);
    });
});

function handleData(data, deviceId) {
    /**
     * 1) Query device to get asset (maybe populate)
     * 2) Use the asset._id to get any available alerts for this device (maybe populate)
     * 3) If there are alerts, check if value is out of range
     * 4) If out of range, get the alert groups from the client
     * 5) Send SMS/Email(s)
     */

}

/**
 * Handle the different ways an application can shutdown
 */

function handleAppExit (options, err) {
    if (err) {
        console.log('App Exit Error: ' + err);
    }

    if (options.cleanup) {
        // Cleanup
    }

    if (options.exit) {
        process.exit();
    }
}

process.on('exit', handleAppExit.bind(null, {
    cleanup: true
}));

process.on('SIGINT', handleAppExit.bind(null, {
    exit: true
}));

process.on('uncaughtException', handleAppExit.bind(null, {
    exit: true
}));
