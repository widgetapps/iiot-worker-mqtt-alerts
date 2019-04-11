'use strict';

require('./init')();

console.log('Version: ' + process.version);

let config = require('./config'),
    mongoose = require('mongoose'),
    _ = require('lodash'),
    mqtt = require('mqtt'),
    mandrill = require('mandrill-api'),
    cbor = require('cbor'),
    moment = require('moment'),
    Device   = require('@terepac/terepac-models').Device,
    Alert    = require('@terepac/terepac-models').Alert;

let mandrillClient = mandrill.Mandrill(config.mandrill.apiKey);

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

    // console.log('Message received: ' + topicId + ':' + type);

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
            if (err) {
                console.log('Error getting device: ' + err);
                return;
            }

            if (!device || err) {
                console.log('Device not found');
                return;
            }

            if (!device.asset || device.asset === null) {
                // Device not assigned to an asset
                console.log('Device not assigned to an asset.');
                return;
            }

            Alert.find({assets: device.asset._id, sensorCode: data.sensorCode})
                .populate('client', {alertGroups: 1})
                .exec(function (err, alerts) {
                    if (!alerts || alerts.length === 0 || err) {
                        return;
                    }

                    let value, limitString;
                    let numbers = [],
                        emails = [{email: 'darryl.patterson@terepac.com', name: 'Darryl'}];

                    //console.log(alerts.length + ' alert(s) found for device/topicId ' + device._id + '/' + topicId + ' with sensor code ' + data.sensorCode);

                    // console.log(JSON.stringify(alerts));

                    // Loop through found alerts
                    _.forEach(alerts, function (alert) {
                        let lastSent, timeout;

                        // If there's no lastSent date in the DB, add one in the past, otherwise get it.
                        if (!alert.lastSent) {
                            lastSent = moment(new Date()).subtract(alert.frequencyMinutes + 5, 'm');
                        } else {
                            lastSent = moment(new Date(alert.lastSent));
                        }
                        // Calculate the timeout date
                        timeout = moment(lastSent).add(alert.frequencyMinutes, 'm');
                        //console.log('Last Sent: ' + lastSent.format());
                        //console.log('Timeout: ' + timeout.format());
                        //console.log('Now: ' + moment(new Date()).format());
                        //console.log('Data: ' + data.min + '/' + data.max);
                        //console.log('Limits: ' + JSON.stringify(alert.limits));

                        // Check if the message timeout has passed
                        if (moment(new Date()).isAfter(timeout)) {
                            // Check if an alert limit has been exceeded
                            if (data.min < alert.limits.low) {
                                value = data.min;
                                limitString = 'minimum';
                            } else if (data.max > alert.limits.high) {
                                value = data.max;
                                limitString = 'maximum';
                            } else {
                                value = null;
                            }

                            // If there's a value, check the alertGroups
                            if (value !== null) {
                                //console.log('A ' + limitString + ' limit has been exceeded: ' + value);
                                //console.log('Alert group codes to send to: ' + alert.alertGroupCodes);
                                //console.log('Client alert groups: ' + alert.client.alertGroups);

                                _.forEach(alert.alertGroupCodes, function (alertGroupCode) {
                                    let alertGroup = _.find(alert.client.alertGroups, ['code', alertGroupCode]);

                                    if (alertGroup) {
                                        _.forEach(alertGroup.contacts, function (contact) {
                                            if (contact.sms.send) {
                                                numbers.push(contact.sms.number);
                                            }
                                            if (contact.email.send) {
                                                emails.push({
                                                    email: contact.email.address,
                                                    name: contact.name
                                                });
                                            }
                                        });
                                    }
                                });

                            }
                        }

                    });

                    if (numbers.length > 0) {
                        //console.log('Sending SMS to these numbers: ' + JSON.stringify(numbers));
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
                            sendMessages(numbers, emails, device.asset.name, data.sensorCode, value, limitString);
                        });
                    }
                });

        });
}

function sendMessages(numbers, emails, asset, sensor, value, limitString) {

    if (numbers.length > 0) {

        const twilio = require('twilio')(config.twilio.accountSid, config.twilio.authToken);
        const service = twilio.notify.services(config.twilio.notifySid);

        const bindings = numbers.map(number => {
            return JSON.stringify({ binding_type: 'sms', address: number });
        });

        const body ='Threshold ' + limitString + ' exceeded for ' + sensor + ' on asset ' + asset + '. VALUE: ' + value;

        //console.log('SMS to ' + JSON.stringify(numbers));
        //console.log('MESSAGE: ' + body);

        let notification = service.notifications
            .create({
                toBinding: bindings,
                body: body
            })
            .then(() => {
                console.log(notification);
                if (emails.length > 0) {
                    sendEmails(emails, asset, sensor, value, limitString);
                }
            })
            .catch(err => {
                console.error(err);
                if (emails.length > 0) {
                    sendEmails(emails, asset, sensor, value, limitString);
                }
            });

    } else {
        if (emails.length > 0) {
            sendEmails(emails, asset, sensor, value, limitString);
        }
    }

}

function sendEmails(emails, asset, sensor, value, limitString) {

    let async = false;
    let ip_pool = "Main Pool";
    let send_at = "example send_at";

    let message = {
        html: '<p>Threshold ' + limitString + ' exceeded for ' + sensor + ' on asset ' + asset + '. VALUE: ' + value + '</p>',
        text: 'Threshold ' + limitString + ' exceeded for ' + sensor + ' on asset ' + asset + '. VALUE: ' + value,
        subject: '[Alert] Threshold exceeded',
        from_email: 'alerts@terepac.one',
        from_name: 'ONE Platform',
        to: emails,
        headers: {
            'Reply-To': 'support@terepac.one'
        },
        important: true,
        track_opens: false,
        track_clicks: false,
        auto_text: false,
        auto_html: false,
        inline_css: true,
        url_strip_qs: false,
        preserve_recipients: false,
        view_content_link: false,
        merge: true,
        async: true
    };

    mandrillClient.messages.send({"message": message, "async": async, "ip_pool": ip_pool, "send_at": send_at}, function(result) {
        console.log(result);
    }, function(e) {
        // Mandrill returns the error as an object with name and message keys
        console.log('A mandrill error occurred: ' + e.name + ' - ' + e.message);
    });
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
