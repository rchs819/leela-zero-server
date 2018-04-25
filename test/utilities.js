const { network_exists, asyncMiddleware } = require('../classes/utilities.js');
var assert = require('assert');
const crypto = require('crypto');

describe('Utilities', function () {
    describe('#network_exists()', function () {
        var hash = crypto.randomBytes(256 / 8).toString('hex');

        var tests = [
            { description: 'should return false for random hash (' + hash + ')', input: hash, expect: false },
            { description: 'should return true for `best-network`', input: 'best-network', expect: true },
        ];

        tests.forEach(test => it(test.description, () => assert.equal(network_exists(test.input), test.expect)));
    });

    describe('#asyncMiddleware()', function () {
        it('should ', () => {
           

            asyncMiddleware(async () => {
                throw new Error('intended error');
            })(null, null, console.log);

        });
        
    });
});