'use strict';

module.exports = {
    db: 'mongodb://10.240.0.21,10.240.0.22,10.240.0.23,10.240.162.13,10.240.253.155/one-platform?replicaSet=rs0',
    dbOptions: { useNewUrlParser: true,  useCreateIndex: true, useFindAndModify: false },
    mqtt: process.env.MQTT || 'mqtts://10.240.0.16:8883',
    mqttoptions: {
        clientId: 'worker_alerts',
        username: 'worker',
        keepalive: 60,
        clean: false,
        password: process.env.MQTT_PASSWORD || ''
    }
};
