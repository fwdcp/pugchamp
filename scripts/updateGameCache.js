/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').boolean('a').argv;
const config = require('config');
const debug = require('debug')('pugchamp:scripts:updateGameCache');
const moment = require('moment');

const helpers = require('../helpers');

var cache = require('../cache');
var database = require('../database');

(async function() {
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const ROLES = config.get('app.games.roles');

    try {
        let games;

        if (!argv.a) {
            /* eslint-disable lodash/prefer-lodash-method */
            games = await database.Game.find({
                '_id': {
                    $in: argv._
                }
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }
        else {
            /* eslint-disable lodash/prefer-lodash-method */
            games = await database.Game.find({}).exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }

        debug(`updating game cache for ${_.size(games)} games`);

        for (let game of games) {
            let gameID = helpers.getDocumentID(game);

            let gamePage = {
                game: game.toObject()
            };

            let gameUsers = _(
                /* eslint-disable lodash/prefer-lodash-method */
                await database.User.find({
                    '_id': {
                        $in: _.map(helpers.getGameUsers(game), user => helpers.getDocumentID(user))
                    }
                }).exec()
                /* eslint-enable lodash/prefer-lodash-method */
            ).invokeMap('toObject').keyBy(user => helpers.getDocumentID(user)).value();

            /* eslint-disable lodash/prefer-lodash-method */
            let ratings = HIDE_RATINGS ? {} : _.keyBy(await database.Rating.find({
                game: gameID
            }).exec(), rating => helpers.getDocumentID(rating.user));
            /* eslint-enable lodash/prefer-lodash-method */

            _.forEach(gamePage.game.teams, function(team) {
                team.captain = gameUsers[helpers.getDocumentID(team.captain)];

                team.composition = _.sortBy(team.composition, function(role) {
                    return _(ROLES).keys().indexOf(role.role);
                });

                _.forEach(team.composition, function(role) {
                    role.role = _.assign({
                        id: role.role
                    }, ROLES[role.role]);

                    _.forEach(role.players, function(player) {
                        player.user = gameUsers[helpers.getDocumentID(player.user)];

                        if (!HIDE_RATINGS) {
                            let rating = ratings[helpers.getDocumentID(player.user)];

                            if (rating) {
                                player.rating = {
                                    rating: rating.after.mean,
                                    deviation: rating.after.deviation,
                                    change: rating.after.mean - rating.before.mean
                                };
                            }
                        }
                    });
                });
            });

            await cache.setAsync(`gamePage-${gameID}`, JSON.stringify(gamePage));
        }

        /* eslint-disable lodash/prefer-lodash-method */
        let gamesCache = await database.Game.find({
            $or: [{
                status: {
                    $in: ['initializing', 'launching', 'live']
                }
            }, {
                status: {
                    $in: ['aborted', 'completed']
                },
                date: {
                    $gte: moment().subtract(1, 'days').toDate()
                }
            }]
        }).sort('-date').select('date status teams.faction teams.captain score map duration').populate('teams.captain', 'alias steamID').exec();
        /* eslint-enable lodash/prefer-lodash-method */

        await cache.setAsync('recentGameList', JSON.stringify(_.invokeMap(gamesCache, 'toObject')));
        await cache.setAsync('recentVisibleGameList', JSON.stringify(_(gamesCache).filter(game => game.status !== 'initializing' && game.status !== 'aborted').invokeMap('toObject').value()));

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
})();
