'use strict';

const _ = require('lodash');
const bodyParser = require('body-parser');
const co = require('co');
const config = require('config');
const express = require('express');
const HttpStatus = require('http-status-codes');
const moment = require('moment');
const ms = require('ms');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const ADMINS = config.get('app.users.admins');
    const ADMIN_LOG_CHANNEL = config.has('server.slack.channels.adminLog') ? config.get('server.slack.channels.adminLog') : '#admin-log';
    const ADMIN_REQUEST_CHANNEL = config.has('server.slack.channels.adminRequest') ? config.get('server.slack.channels.adminRequest') : '#admin-request';
    const BASE_URL = config.get('server.baseURL');
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const HIDE_DRAFT_STATS = config.get('app.users.hideDraftStats');
    const RESTRICTION_DURATIONS = config.get('app.users.restrictionDurations');

    var adminUserIDs = [];

    self.isUserAdmin = function isUserAdmin(user) {
        let userID = helpers.getDocumentID(user);

        return _.includes(adminUserIDs, userID);
    };

    /**
     * @async
     */
    self.postToAdminLog = co.wrap(function* postToAdminLog(user, action) {
        user = yield self.getCachedUser(user);

        let message = {
            channel: ADMIN_LOG_CHANNEL,
            attachments: [{
                fallback: `${user.alias} ${action}`,
                author_name: user.alias,
                author_link: `${BASE_URL}/player/${user.steamID}`,
                text: action
            }]
        };

        yield self.postToSlack(message);
    });

    var router = express.Router();

    router.use('/', function(req, res, next) {
        if (!self.isUserAdmin(req.user)) {
            res.status(HttpStatus.FORBIDDEN).render('unauthorized');
        }
        else {
            next();
            return;
        }
    });

    router.post('/user/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        let user = yield database.User.findById(req.params.id);

        if (!user) {
            res.sendStatus(HttpStatus.NOT_FOUND);
            return;
        }

        if (req.body.type === 'changeSettings') {
            let majorChange = false;

            if (req.body.alias !== user.alias) {
                if (/^[A-Za-z0-9_]{1,20}$/.test(req.body.alias)) {
                    let existingUser = yield self.getUserByAlias(req.body.alias);

                    if (!existingUser || helpers.getDocumentID(existingUser) === helpers.getDocumentID(user)) {
                        self.postToAdminLog(req.user, `changed the alias of \`<${BASE_URL}/player/${user.steamID}|${req.body.alias}>\` from \`${user.alias}\``);

                        let newAlias = req.body.alias;
                        let oldAlias = user.alias;
                        let admin = req.user.alias;
                        let date = new Date();

                        let nameChange = new database.NameChange({
                            user: helpers.getDocumentID(user),
                            newAlias,
                            oldAlias,
                            admin,
                            date
                        });

                        user.alias = req.body.alias;

                        majorChange = true;
                        try {
                            yield nameChange.save();

                        }
                        catch (err) {
                          throw new Error('something went horribly wrong', err);

                        }
                    }
                }
            }

            if (!HIDE_DRAFT_STATS) {
                let showDraftStats = !!req.body.showDraftStats;
                if (showDraftStats !== user.options.showDraftStats) {
                    if (showDraftStats) {
                        self.postToAdminLog(req.user, `enabled showing draft stats for \`<${BASE_URL}/player/${user.steamID}|${user.alias}>\``);
                    }
                    else {
                        self.postToAdminLog(req.user, `disabled showing draft stats for \`<${BASE_URL}/player/${user.steamID}|${user.alias}>\``);
                    }

                    user.options.showDraftStats = showDraftStats;
                }
            }

            if (user.alias) {
                user.setUp = true;
            }

            try {
                yield user.save();
              //  yield nameChange.save();
                yield self.updateUserCache(user);
                yield self.updateUserRestrictions(user);

                if (majorChange) {
                    yield self.updateUserGames(req.user);
                }

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to save settings for <${BASE_URL}/player/${user.steamID}|${user.alias}>: ${JSON.stringify(req.body)}`,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'createRestriction') {
            let aspects = req.body.aspects ? _.split(req.body.aspects, ',') : [];
            let reason = req.body.reason ? req.body.reason : null;

            let expires;
            let duration = _.find(RESTRICTION_DURATIONS, ['name', req.body.duration]);

            if (!duration) {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            if (duration.type === 'temporary') {
                expires = moment().add(ms(duration.length), 'ms');
            }
            else if (duration.type === 'permanent') {
                expires = null;
            }
            else if (duration.type === 'custom') {
                expires = req.body.expires ? req.body.expires : null;
            }

            let restriction = new database.Restriction({
                user: helpers.getDocumentID(user),
                active: true,
                aspects,
                reason,
                expires
            });

            let formattedAspects = _.size(restriction.aspects) > 0 ? ` (aspects: ${restriction.aspects.join(', ')})` : '';
            let formattedExpiration = restriction.expires ? ` (expires: ${moment(restriction.expires).format('llll')})` : ' (expires: never)';
            let formattedReason = restriction.reason ? ` (reason: ${restriction.reason})` : '';
            self.postToAdminLog(req.user, `restricted \`<${BASE_URL}/player/${user.steamID}|${user.alias}>\`${formattedAspects}${formattedExpiration}${formattedReason}`);

            try {
                yield restriction.save();
                yield self.updateUserRestrictions(user);
                yield self.updateUserCache(user);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to apply restriction to <${BASE_URL}/player/${user.steamID}|${user.alias}>: ${JSON.stringify(req.body)}`,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'revokeRestriction') {
            let restriction = yield database.Restriction.findById(req.body.restriction);

            if (!restriction) {
                res.sendStatus(HttpStatus.NOT_FOUND);
                return;
            }

            if (helpers.getDocumentID(user) === helpers.getDocumentID(restriction.user) && restriction.active) {
                let formattedAspects = _.size(restriction.aspects) > 0 ? ` (aspects: ${restriction.aspects.join(', ')})` : '';
                let formattedExpiration = restriction.expires ? ` (expires: ${moment(restriction.expires).format('llll')})` : ' (expires: never)';
                let formattedReason = restriction.reason ? ` (reason: ${restriction.reason})` : '';
                self.postToAdminLog(req.user, `revoked restriction for \`<${BASE_URL}/player/${user.steamID}|${user.alias}>\`${formattedAspects}${formattedExpiration}${formattedReason}`);

                restriction.active = false;

                try {
                    yield restriction.save();
                    yield self.updateUserRestrictions(user);
                    yield self.updateUserCache(user);

                    res.sendStatus(HttpStatus.OK);
                }
                catch (err) {
                    self.postToLog({
                        description: `failed to revoke restriction \`${helpers.getDocumentID(restriction)}\` for <${BASE_URL}/player/${user.steamID}|${user.alias}>`,
                        error: err
                    });

                    res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
                }
            }
            else {
                res.sendStatus(HttpStatus.BAD_REQUEST);
            }
        }
        else if (req.body.type === 'updateRestrictions') {
            try {
                yield self.updateUserRestrictions(user);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to update restrictions for <${BASE_URL}/player/${user.steamID}|${user.alias}>`,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else {
            res.sendStatus(HttpStatus.BAD_REQUEST);
        }
    }));

    router.post('/game/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        let game = yield database.Game.findById(req.params.id);

        if (!game) {
            res.sendStatus(HttpStatus.NOT_FOUND);
            return;
        }

        if (req.body.type === 'requestSubstitute') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            let player = yield self.getCachedUser(req.body.player);

            if (!player) {
                res.sendStatus(HttpStatus.NOT_FOUND);
                return;
            }

            let gameUserInfo = helpers.getGameUserInfo(game, player);

            if (!gameUserInfo || !gameUserInfo.player || gameUserInfo.player.replaced) {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user, `requested substitute for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``);

            self.requestSubstitute(game, player);

            res.sendStatus(HttpStatus.OK);
        }
        else if (req.body.type === 'updateServerPlayers') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user, `updated players for server \`${game.server}\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``);

            try {
                yield self.updateServerPlayers(game);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to update players for server \`${game.server}\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'reinitializeServer') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user, `reinitialized server \`${game.server}\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``);

            try {
                yield self.initializeServer(game);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to reinitialize server \`${game.server}\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'reassignServer') {
            if (game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user, `reassigned game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\` to new server`);

            try {
                yield self.assignGameToServer(game);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to reassign game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\` to new server`,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'abortGame') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user, `aborted game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``);

            try {
                yield self.abortGame(game);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to abort game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else {
            res.sendStatus(HttpStatus.BAD_REQUEST);
        }
    }));

    router.post('/servers', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        if (req.body.type === 'updateStatuses') {
            self.postToAdminLog(req.user, 'updated server statuses');

            yield self.updateServerStatuses();

            res.sendStatus(HttpStatus.OK);
        }
        else {
            res.sendStatus(HttpStatus.BAD_REQUEST);
        }
    }));

    router.post('/server/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        if (!_.has(GAME_SERVER_POOL, req.params.id)) {
            res.sendStatus(HttpStatus.NOT_FOUND);
            return;
        }

        if (req.body.type === 'rconCommand') {
            let trimmedCommand = _.trim(req.body.command);

            if (!trimmedCommand) {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user, `executed \`${req.body.command}\` on server \`${req.params.id}\``);

            try {
                let result = yield self.sendRCONCommands(req.params.id, _.split(req.body.command, ';'));

                res.json(result);
            }
            catch (err) {
                self.postToLog({
                    description: `RCON command \`${req.body.command}\` on server \`${req.params.id}\` failed`,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }

            yield self.updateServerStatus(req.params.id);
        }
        else {
            res.sendStatus(HttpStatus.BAD_REQUEST);
        }
    }));

    app.use('/admin', router);

    /**
     * @async
     */
    self.requestAdmin = co.wrap(function* requestAdmin(user, message) {
        user = yield self.getCachedUser(user);
        let trimmedMessage = _.trim(message);

        yield self.postToSlack({
            channel: ADMIN_REQUEST_CHANNEL,
            attachments: [{
                fallback: trimmedMessage ? `${user.alias} requested help: ${trimmedMessage}` : `${user.alias} requested help`,
                color: 'warning',
                author_name: user.alias,
                author_link: `${BASE_URL}/player/${user.steamID}`,
                text: trimmedMessage
            }]
        });
    });

    function onRequestAdmin(message) {
        let userID = this.decoded_token.user;

        co(function*() {
            let userRestrictions = yield self.getUserRestrictions(userID);

            if (!_.includes(userRestrictions, 'support')) {
                try {
                    yield self.requestAdmin(userID, message);
                }
                catch (err) {
                    self.sendMessageToUser(userID, {
                        action: 'admin request failed'
                    });
                }
            }
        });
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('requestAdmin');
        socket.on('requestAdmin', onRequestAdmin);
    });

    co(function*() {
        /* eslint-disable lodash/prefer-lodash-method */
        let admins = yield database.User.find({
            'steamID': {
                $in: ADMINS
            }
        }).exec();
        /* eslint-enable lodash/prefer-lodash-method */

        adminUserIDs = _.map(admins, user => helpers.getDocumentID(user));
    });
};
