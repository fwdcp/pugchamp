/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const argv = require('yargs').boolean('a').argv;

var database = require('../database');

(async function() {
    try {
        let users;

        if (!argv.a) {
            /* eslint-disable lodash/prefer-lodash-method */
            users = await database.User.find({
                '_id': {
                    $in: argv._
                }
            }, 'stats').exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }
        else {
            /* eslint-disable lodash/prefer-lodash-method */
            users = await database.User.find({}, 'stats').exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }

        for (let user of users) {
            let oldMean = user.stats.rating.mean;
            let oldDeviation = user.stats.rating.deviation;

            user.stats.rating.mean = 1500;
            user.stats.rating.deviation = 500;

            let newRating = new database.Rating({
                user,
                date: new Date(),
                before: {
                    mean: oldMean,
                    deviation: oldDeviation
                },
                after: {
                    mean: 1500,
                    deviation: 500
                }
            });

            await newRating.save();
            await user.save();
        }

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
})();
