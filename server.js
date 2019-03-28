'use strict';

require('./init')();

console.log('Version: ' + process.version);

let config = require('./config'),
    mongoose = require('mongoose'),
    _ = require('lodash'),
    mqtt = require('mqtt'),
    cbor = require('cbor'),
    moment = require('moment'),
    Device   = require('@terepac/terepac-models').Device,
    Alert    = require('@terepac/terepac-models').Alert;

mongoose.Promise = global.Promise;

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

    let topicId, type;
    let topics = topic.split('/');

    if (topics[1] === 'gateway') {
        topicId = topics[0];
        type = topics[3];

    } else {
        topicId = topics[0];
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
            min: decoded.value,
            max: decoded.value
        };

        switch (type) {
            case 'pressure':
                data.sensorType = 1;
                data.sensorCode = 'PI';
                data.min     = decoded.min;
                data.max     = decoded.max;
                break;
            case 'temperature':
                data.sensorType = 2;
                data.sensorCode = 'TI';
                break;
            case 'battery':
                data.sensorType = 4;
                data.sensorCode = 'EI';
                break;
            case 'vibration':
                data.sensorType = 8;
                data.sensorCode = 'VI';
                break;
            case 'humidity':
                data.sensorType = 9;
                data.sensorCode = 'CI';
                break;
            case 'rssi':
                data.sensorType = 10;
                data.sensorCode = 'MI';
                data.min     = decoded.min;
                data.max     = decoded.max;
                break;
        }
        handleData(data, topicId);
    });
});

function handleData(data, topicId) {

    Device.findOne({ topicId: topicId })
        .populate('asset')
        .exec(function (err, device) {
            if (!device || err) {
                console.log('Device not found');
                return;
            }

            if (!device.asset || device.asset === null) {
                // Device not assigned to an asset
                return;
            }

            Alert.find({assets: device.asset._id, sensorCode: data.sensorCode})
                .populate('client')
                .exec(function (err, alerts) {
                    if (!alerts || err) {
                        return;
                    }
                    let value, limitString;
                    let numbers = [];

                    _.forEach(alerts, function (alert) {
                        let lastSent, timeout;

                        if (!alert.lastSent) {
                            lastSent = moment(new Date()).subtract(alert.frequencyMinutes + 5, 'm');
                        } else {
                            lastSent = new Date(alert.lastSent);
                        }
                        timeout = moment(lastSent).add(alert.frequencyMinutes, 'm');

                        if (moment(new Date()).isAfter(timeout)) {
                            if (data.min < alert.limits.low) {
                                value = data.min;
                                limitString = 'minimum';
                            } else if (data.max > alert.limits.high) {
                                value = data.max;
                                limitString = 'maximum';
                            }

                            if (value) {

                                _.forEach(alert.alertGroupCodes, function (alertGroupCode) {
                                    let alertGroup = _.find(device.client.alertGroups, ['code', alertGroupCode]);

                                    if (alertGroup) {
                                        _.forEach(alertGroup.contacts, function (contact) {
                                            if (contact.sms.send) {
                                                numbers.push(contact.sms.number);
                                            }
                                        });
                                    }
                                });

                            }
                        }

                    });

                    if (numbers.length > 0) {
                        // Update lastSent & lastValue in alert
                        Alert.updateMany(
                            {assets: device.asset._id, sensorCode: data.sensorCode},
                            {
                                $set: {
                                    lastSent: new Date(),
                                    updated: new Date()
                                }
                            },
                        ).exec(function(err, updateAlert) {
                            sendMessages(numbers, device.asset.name, data.sensorCode, value, limitString);
                        });
                    }
                });

        });
}

function sendMessages(numbers, asset, sensor, value, limitString) {

    const twilio = require('twilio')(config.twilio.accountSid, config.twilio.authToken);
    const service = twilio.notify.services(config.twilio.notifySid);

    const bindings = numbers.map(number => {
        return JSON.stringify({ binding_type: 'sms', address: number });
    });

    const body ='Threshold ' + limitString + ' exceeded for ' + sensor + ' on asset ' + asset + '. VALUE: ' + value;

    console.log('SMS to ' + numbers);
    console.log('MESSAGE: ' + body);
    /*
    let notification = service.notifications
        .create({
            toBinding: bindings,
            body: body
        })
        .then(() => {
            console.log(notification);
        })
        .catch(err => {
            console.error(err);
        });
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
