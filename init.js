'use strict';

/**
 * Module dependencies.
 */
let fs = require('fs');

/**
 * Module init function.
 */
module.exports = function() {
    /**
     * Before we begin, lets set the environment variable
     * We'll Look for a valid NODE_ENV variable and if one cannot be found load the development NODE_ENV
     */

    try {
        fs.accessSync('./env/' + process.env.NODE_ENV + '.js', fs.F_OK);
    } catch (e) {
        process.env.NODE_ENV = 'local'
    }

};