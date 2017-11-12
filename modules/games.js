'use strict';

const _ = require('lodash');
const child_process = require('mz/child_process');
const config = require('config');
const fs = require('fs');
const hbs = require('hbs');
const HttpStatus = require('http-status-codes');
const math = require('mathjs');
const moment = require('moment');
const ms = require('ms');
const path = require('path');

require('moment-duration-format');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const DOMINANCE_PENALTY_THRESHOLD = config.get('app.games.dominancePenaltyThreshold');
    const HIDE_CAPTAINS = config.get('app.games.hideCaptains');
    const MAPS = config.get('app.games.maps');
    const MONGODB_URL = config.get('server.mongodb');
    const POST_GAME_RESET_DELAY = ms(config.get('app.games.postGameResetDelay'));
    const RATING_BASE = config.get('app.users.ratingBase');
    const ROLES = config.get('app.games.roles');
    const SUBSTITUTE_REQUEST_PERIOD = ms(config.get('app.games.substituteRequestPeriod'));
    const SUBSTITUTE_SELECTION_METHOD = config.get('app.games.substituteSelectionMethod');

    self.updateGameCache = async function updateGameCache(...games) {
        await helpers.runAppScript('updateGameCache', _.map(games, game => helpers.getDocumentID(game)));
    };

    async function rateGame(game) {
        await child_process.exec(`python rate_game.py ${helpers.getDocumentID(game)}`, {
            cwd: path.resolve(__dirname, '../ratings')
        });
    }

    async function calculateQuality(game) {
        await child_process.exec(`python calculate_quality.py ${helpers.getDocumentID(game)}`, {
            cwd: path.resolve(__dirname, '../ratings')
        });
    }

    async function updateCurrentGame(users) {
        await helpers.runAppScript('updateCurrentGame', _.map(users, user => helpers.getDocumentID(user)));

        let cachedCurrentGames = _.zipObject(_.map(users, user => helpers.getDocumentID(user)), await cache.mgetAsync(_.map(users, user => `currentGame-${helpers.getDocumentID(user)}`)));

        _.forEach(cachedCurrentGames, function(cacheResponse, userID) {
            self.emitToUser(userID, 'currentGameUpdated', _.isNil(cacheResponse) ? null : JSON.parse(cacheResponse));
        });
    }

    async function getCurrentGame(user) {
        let cacheResponse = await cache.getAsync(`currentGame-${helpers.getDocumentID(user)}`);

        return _.isNil(cacheResponse) ? null : JSON.parse(cacheResponse);
    }

    async function getGameList(invisible) {
        let keyName;

        if (invisible) {
            keyName = 'recentGameList';
        }
        else {
            keyName = 'recentVisibleGameList';
        }

        if (!(await cache.existsAsync(keyName))) {
            await self.updateGameCache();
        }

        return JSON.parse(await cache.getAsync(keyName));
    }

    self.processGameUpdate = async function processGameUpdate(game) {
        let gameID = helpers.getDocumentID(game);
        game = await database.Game.findById(gameID);

        if (game.status !== 'initializing') {
            if (helpers.getDocumentID(game) === self.getCurrentDraftGame()) {
                await self.cleanUpDraft();
            }
        }

        await self.updateUserRestrictions(...helpers.getGameUsers(game));
        await updateCurrentGame(helpers.getGameUsers(game));

        self.updateGameCache(game);
        self.updateUserCache(...helpers.getGameUsers(game));
    };

    var currentSubstituteRequests = new Map();

    self.getCurrentSubstituteRequests = function getCurrentSubstituteRequests() {
        return _.toArray(currentSubstituteRequests.values());
    };

    async function updateSubstituteRequestsMessage() {
        let substituteRequestsMessage = {
            requests: []
        };

        let outgoingPlayers = _.keyBy(await self.getCachedUsers(_(currentSubstituteRequests.values()).toArray().map('player').value()), user => helpers.getDocumentID(user));

        for (let request of currentSubstituteRequests.entries()) {
            substituteRequestsMessage.requests.push({
                id: request[0],
                game: request[1].game,
                role: ROLES[request[1].role],
                captain: helpers.getDocumentID(request[1].captain),
                player: outgoingPlayers[helpers.getDocumentID(request[1].player)],
                candidates: _.toArray(request[1].candidates),
                startTime: request[1].opened,
                endTime: request[1].opened + SUBSTITUTE_REQUEST_PERIOD
            });
        }

        await cache.setAsync('substituteRequests', JSON.stringify(substituteRequestsMessage));

        io.sockets.emit('substituteRequestsUpdated', substituteRequestsMessage);
    }

    async function getSubstituteRequestsMessage() {
        if (!(await cache.existsAsync('substituteRequests'))) {
            await updateSubstituteRequestsMessage();
        }

        return JSON.parse(await cache.getAsync('substituteRequests'));
    }

    self.processSubstituteRequestsUpdate = _.debounce(async function processSubstituteRequestsUpdate() {
        await updateSubstituteRequestsMessage();
    });

    async function attemptSubstitution(requestID) {
        if (!currentSubstituteRequests.has(requestID)) {
            return;
        }

        let request = currentSubstituteRequests.get(requestID);

        if (request.timeout) {
            clearTimeout(request.timeout);
            request.timeout = null;
        }

        let game = await database.Game.findById(helpers.getDocumentID(request.game));

        if (!game || game.status === 'completed' || game.status === 'aborted') {
            self.removeSubstituteRequest(requestID);
            return;
        }

        let player = await database.User.findById(helpers.getDocumentID(request.player)).exec();

        let gameUserInfo = helpers.getGameUserInfo(game, player);

        if (!gameUserInfo || !gameUserInfo.player || gameUserInfo.player.replaced) {
            self.removeSubstituteRequest(requestID);
            return;
        }

        let penalty = await database.Penalty.findOne({
            'user': helpers.getDocumentID(player),
            'type': 'general',
            'game': helpers.getDocumentID(request.game)
        }).exec();
        if (!penalty) {
            penalty = new database.Penalty({
                user: helpers.getDocumentID(player),
                type: 'general',
                game: helpers.getDocumentID(request.game),
                reason: 'being replaced out of a game',
                date: new Date(),
                active: true
            });
            await penalty.save();
            await self.updateUserCache(player);
            await self.updateUserRestrictions(player);
        }

        if (request.candidates.size === 0) {
            return;
        }

        let candidates = _.toArray(request.candidates);
        let selectedCandidate;

        if (SUBSTITUTE_SELECTION_METHOD === 'first') {
            selectedCandidate = _.head(candidates);
        }
        else if (SUBSTITUTE_SELECTION_METHOD === 'closest') {
            /* eslint-disable lodash/prefer-lodash-method */
            let candidatePlayers = await database.User.find({
                '_id': {
                    $in: candidates
                }
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */

            selectedCandidate = helpers.getDocumentID(_.minBy(candidatePlayers, candidate => math.abs(candidate.stats.rating.mean - player.stats.rating.mean)));
        }
        else if (SUBSTITUTE_SELECTION_METHOD === 'mutual') {
            let currentPlayers = _(game).thru(helpers.getCurrentPlayers).map(user => helpers.getDocumentID(user)).without(helpers.getDocumentID(player)).value();

            let currentPlayerGames = await database.Game.count({
                'teams.composition.players.user': {
                    $in: currentPlayers
                }
            }).exec();

            let candidateScores = {};

            for (let candidate of candidates) {
                let candidateGames = await database.Game.count({
                    'teams.composition.players.user': helpers.getDocumentID(candidate)
                }).exec();

                let commonGames = await database.Game.count({
                    $and: [{
                        'teams.composition.players.user': helpers.getDocumentID(candidate)
                    }, {
                        'teams.composition.players.user': {
                            $in: currentPlayers
                        }
                    }]
                }).exec();

                let score = (commonGames * commonGames) / (candidateGames * currentPlayerGames);

                candidateScores[helpers.getDocumentID(candidate)] = _.isFinite(score) ? score : 0;
            }

            selectedCandidate = helpers.getDocumentID(_.maxBy(candidates, candidate => candidateScores[helpers.getDocumentID(candidate)]));
        }
        else if (SUBSTITUTE_SELECTION_METHOD === 'random') {
            selectedCandidate = chance.pick(candidates);
        }

        try {
            await self.performSubstitution(game, player, selectedCandidate);
        }
        catch (err) {
            self.postToLog({
                description: `error in making substitution for \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``,
                error: err
            });

            self.sendMessage({
                action: `failed to substitute out [${player.alias}](/player/${player.steamID}) from [game](/game/${helpers.getDocumentID(game)}) due to internal error`
            });
        }

        self.removeSubstituteRequest(requestID);
    }

    async function updateSubstituteApplication(requestID, player, active) {
        if (!currentSubstituteRequests.has(requestID)) {
            return;
        }

        let userRestrictions = await self.getUserRestrictions(player);
        let request = currentSubstituteRequests.get(requestID);

        if (!_.includes(userRestrictions.aspects, 'sub')) {
            if (active) {
                request.candidates.add(player);
            }
            else {
                request.candidates.delete(player);
            }
        }

        self.processSubstituteRequestsUpdate();

        if (!request.timeout) {
            await attemptSubstitution(requestID);
        }
    }

    self.removeGameSubstituteRequests = function removeGameSubstituteRequests(game) {
        let gameID = helpers.getDocumentID(game);

        _(currentSubstituteRequests.entries()).toArray().filter(request => (helpers.getDocumentID(request[1].game) === gameID)).forEach(function(request) {
            self.removeSubstituteRequest(request[0]);
        });
    };

    self.requestSubstitute = function requestSubstitute(game, player) {
        if (!game || game.status === 'completed' || game.status === 'aborted') {
            return;
        }

        let gameUserInfo = helpers.getGameUserInfo(game, player);

        if (!gameUserInfo || !gameUserInfo.player || gameUserInfo.player.replaced) {
            return;
        }

        if (currentSubstituteRequests.has(helpers.getDocumentID(gameUserInfo.player))) {
            return;
        }

        currentSubstituteRequests.set(helpers.getDocumentID(gameUserInfo.player), {
            game: helpers.getDocumentID(game),
            role: gameUserInfo.role.role,
            captain: helpers.getDocumentID(gameUserInfo.team.captain),
            player: helpers.getDocumentID(player),
            opened: Date.now(),
            candidates: new Set(),
            timeout: setTimeout(attemptSubstitution, SUBSTITUTE_REQUEST_PERIOD, helpers.getDocumentID(gameUserInfo.player))
        });

        self.processSubstituteRequestsUpdate();
    };

    self.performSubstitution = async function performSubstitution(game, oldPlayer, newPlayer) {
        if (!game || !oldPlayer || !newPlayer) {
            return;
        }

        let oldPlayerID = helpers.getDocumentID(oldPlayer);
        let newPlayerID = helpers.getDocumentID(newPlayer);

        _(game.teams).flatMap('composition').forEach(function(role) {
            let player = _.find(role.players, function(currentPlayer) {
                return !currentPlayer.replaced && oldPlayerID === helpers.getDocumentID(currentPlayer.user);
            });

            if (player) {
                player.replaced = true;

                role.players.push({
                    user: newPlayerID
                });
            }
        });

        await game.save();

        await self.processGameUpdate(game);

        await self.updateServerPlayers(game);
    };

    self.abortGame = async function abortGame(game) {
        if (!game) {
            return;
        }

        if (game.status === 'aborted' || game.status === 'completed') {
            return;
        }

        game.status = 'aborted';

        await game.save();

        await self.processGameUpdate(game);
        self.removeGameSubstituteRequests(game);

        await self.shutdownGameServers(game);
    };

    self.removeSubstituteRequest = function removeSubstituteRequest(requestID) {
        if (currentSubstituteRequests.has(requestID)) {
            let request = currentSubstituteRequests.get(requestID);

            if (request.timeout) {
                clearTimeout(request.timeout);
            }

            currentSubstituteRequests.delete(requestID);

            self.processSubstituteRequestsUpdate();
        }
    };

    self.handleGameServerUpdate = async function handleGameServerUpdate(info) {
        let game = await database.Game.findById(info.game).populate('teams.captain', 'alias steamID').exec();

        if (info.status === 'setup') {
            if (game.status !== 'initializing' && game.status !== 'launching') {
                self.postToLog({
                    description: `game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\` was ${game.status} but is being reported as set up`
                });

                return;
            }

            game.status = 'launching';

            await game.save();

            await self.processGameUpdate(game);
        }
        else if (info.status === 'live') {
            if (game.status === 'aborted' || game.status === 'completed') {
                self.postToLog({
                    description: `game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\` was ${game.status} but is being reported as live`
                });

                return;
            }

            game.status = 'live';

            if (info.score) {
                game.score = _.map(game.teams, team => info.score[team.faction]);
            }

            if (info.duration) {
                game.duration = info.duration;
            }

            if (info.time) {
                /* eslint-disable lodash/prefer-lodash-method */
                let gameUsers = _.keyBy(await database.User.find({
                    '_id': {
                        $in: _.map(helpers.getGameUsers(game), user => helpers.getDocumentID(user))
                    }
                }), user => helpers.getDocumentID(user));
                /* eslint-enable lodash/prefer-lodash-method */

                for (let team of game.teams) {
                    for (let role of team.composition) {
                        for (let player of role.players) {
                            let user = gameUsers[helpers.getDocumentID(player.user)];

                            if (user && _.has(info.time, user.steamID)) {
                                player.time = info.time[user.steamID];
                            }
                        }
                    }
                }
            }

            await game.save();

            await self.processGameUpdate(game);

            let action = `[game](/game/${helpers.getDocumentID(game)}) update: live`;
            if (!_.isNil(game.duration)) {
                let duration = moment.duration(game.duration, 'seconds').format('m:ss', {
                    trim: false
                });
                action += ` for ${duration}`;
            }
            if (game.map) {
                let map = MAPS[game.map].name;
                action += ` on ${map}`;
            }
            if (_.size(game.score) > 0) {
                let score = _(game.teams).map((team, index) => `${(HIDE_CAPTAINS || !team.captain) ? team.faction : team.captain.alias} ${game.score[index]}`).join(', ');
                action += ` with current score ${score}`;
            }

            self.sendMessage({
                action
            });
        }
        else if (info.status === 'completed') {
            if (game.status === 'aborted') {
                self.postToLog({
                    description: `game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\` was ${game.status} but is being reported as completed`
                });

                return;
            }
            else if (game.status === 'completed') {
                // NOTE: being completed is fine, we just don't want to rerun the completion functions again since we already have data

                return;
            }

            game.status = 'completed';

            if (info.score) {
                game.score = _.map(game.teams, team => info.score[team.faction]);
            }

            if (info.duration) {
                game.duration = info.duration;
            }

            if (info.time) {
                /* eslint-disable lodash/prefer-lodash-method */
                let gameUsers = _.keyBy(await database.User.find({
                    '_id': {
                        $in: _.map(helpers.getGameUsers(game), user => helpers.getDocumentID(user))
                    }
                }), user => helpers.getDocumentID(user));
                /* eslint-enable lodash/prefer-lodash-method */

                for (let team of game.teams) {
                    for (let role of team.composition) {
                        for (let player of role.players) {
                            let user = gameUsers[helpers.getDocumentID(player.user)];

                            if (user && _.has(info.time, user.steamID)) {
                                player.time = info.time[user.steamID];
                            }
                        }
                    }
                }
            }

            await game.save();

            await self.processGameUpdate(game);
            self.removeGameSubstituteRequests(game);
            setTimeout(self.shutdownGameServers, POST_GAME_RESET_DELAY, game);

            let action = `[game](/game/${helpers.getDocumentID(game)}) update: completed`;
            if (!_.isNil(game.duration)) {
                let duration = moment.duration(game.duration, 'seconds').format('m:ss', {
                    trim: false
                });
                action += ` after ${duration}`;
            }
            if (game.map) {
                let map = MAPS[game.map].name;
                action += ` on ${map}`;
            }
            if (_.size(game.score) > 0) {
                let score = _(game.teams).map((team, index) => `${(HIDE_CAPTAINS || !team.captain) ? team.faction : team.captain.alias} ${game.score[index]}`).join(', ');
                action += ` with final score ${score}`;
            }

            self.sendMessage({
                action
            });

            try {
                await rateGame(game);
                await calculateQuality(game);

                await self.updatePlayerStats(...helpers.getGameUsers(game));

                await self.updateGameCache(game);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to update stats for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``,
                    error: err
                });
            }

            if (!_.isNil(DOMINANCE_PENALTY_THRESHOLD) && _.isNumber(game.stats.dominanceScore) && math.abs(game.stats.dominanceScore) > DOMINANCE_PENALTY_THRESHOLD) {
                let captain;

                if (game.stats.dominanceScore < 0) {
                    captain = game.teams[0].captain;
                }
                else if (game.stats.dominanceScore > 0) {
                    captain = game.teams[1].captain;
                }

                if (captain) {
                    let penalty = new database.Penalty({
                        user: helpers.getDocumentID(captain),
                        type: 'captain',
                        reason: 'inferior team performance',
                        date: new Date(),
                        active: true
                    });
                    await penalty.save();

                    await self.updateUserCache(captain);
                    await self.updateUserRestrictions(captain);
                }
            }
        }
        else if (info.status === 'logavailable') {
            if (info.url) {
                let link = _.find(game.links, ['type', 'logs.tf']);

                if (link) {
                    link.url = info.url;
                }
                else {
                    game.links.push({
                        type: 'logs.tf',
                        url: info.url
                    });
                }

                await game.save();

                await self.updateGameCache(game);
            }
        }
        else if (info.status === 'demoavailable') {
            if (info.url) {
                let link = _.find(game.links, ['type', 'demos.tf']);

                if (link) {
                    link.url = info.url;
                }
                else {
                    game.links.push({
                        type: 'demos.tf',
                        url: info.url
                    });
                }

                await game.save();

                await self.updateGameCache(game);
            }
        }
    };

    io.sockets.on('connection', async function(socket) {
        socket.emit('substituteRequestsUpdated', await getSubstituteRequestsMessage());
    });

    async function onUserRequestSubstitute(info) {
        let userID = this.decoded_token.user;

        try {
            let game = await database.Game.findById(info.game);

            let playerInfo = helpers.getGameUserInfo(game, info.player);

            if (userID !== helpers.getDocumentID(playerInfo.team.captain)) {
                return;
            }

            let player = await self.getCachedUser(info.player);
            let captain = await self.getCachedUser(userID);

            self.postToLog({
                description: `\`<${BASE_URL}/player/${captain.steamID}|${captain.alias}>\` requested substitute for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``
            });

            self.requestSubstitute(game, info.player);
        }
        catch (err) {
            console.error(err.stack);
        }
    }

    async function onUserUpdateSubstituteApplication(info) {
        let userID = this.decoded_token.user;

        try {
            await updateSubstituteApplication(info.request, userID, info.status);
        }
        catch (err) {
            console.error(err.stack);
        }
    }

    async function onUserRetractSubstituteRequest(requestID) {
        let userID = this.decoded_token.user;

        try {
            if (!currentSubstituteRequests.has(requestID)) {
                return;
            }

            let request = currentSubstituteRequests.get(requestID);
            let game = await database.Game.findById(request.game);

            let player = await self.getCachedUser(request.player);

            let playerInfo = helpers.getGameUserInfo(game, player);

            if (userID === helpers.getDocumentID(playerInfo.team.captain)) {
                let captain = await self.getCachedUser(userID);

                self.postToLog({
                    description: `\`<${BASE_URL}/player/${captain.steamID}|${captain.alias}>\` retracted substitute request for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``
                });

                let penalty = await database.Penalty.findOne({
                    'user': helpers.getDocumentID(player),
                    'type': 'general',
                    'game': helpers.getDocumentID(request.game),
                    'reason': 'being replaced out of a game'
                }).exec();
                if (penalty) {
                    await penalty.remove();
                    await self.updateUserCache(player);
                    await self.updateUserRestrictions(player);
                }

                self.removeSubstituteRequest(requestID);
            }
            else if (self.isUserAdmin(userID)) {
                self.postToAdminLog(userID, `retracted substitute request for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``);

                let penalty = await database.Penalty.findOne({
                    'user': helpers.getDocumentID(player),
                    'type': 'general',
                    'game': helpers.getDocumentID(request.game),
                    'reason': 'being replaced out of a game'
                }).exec();
                if (penalty) {
                    await penalty.remove();
                    await self.updateUserCache(player);
                    await self.updateUserRestrictions(player);
                }

                self.removeSubstituteRequest(requestID);
            }
        }
        catch (err) {
            console.error(err.stack);
        }
    }

    io.sockets.on('authenticated', async function(socket) {
        let userID = socket.decoded_token.user;

        socket.emit('currentGameUpdated', await getCurrentGame(userID));

        socket.removeAllListeners('requestSubstitute');
        socket.on('requestSubstitute', onUserRequestSubstitute);

        socket.removeAllListeners('updateSubstituteApplication');
        socket.on('updateSubstituteApplication', onUserUpdateSubstituteApplication);

        socket.removeAllListeners('retractSubstituteRequest');
        socket.on('retractSubstituteRequest', onUserRetractSubstituteRequest);
    });

    self.on('userRestrictionsUpdated', function(userID, userRestrictions) {
        if (_.includes(userRestrictions.aspects, 'sub')) {
            for (let request of currentSubstituteRequests.values()) {
                request.candidates.delete(userID);
            }
        }

        self.processSubstituteRequestsUpdate();
    });

    hbs.registerHelper('ratingChange', function(change) {
        if (change > 0) {
            return new hbs.handlebars.SafeString(`<span class="rating-increase"><iron-icon icon="arrow-upward"></iron-icon> ${math.round(+change)}</span>`);
        }
        else if (change < 0) {
            return new hbs.handlebars.SafeString(`<span class="rating-decrease"><iron-icon icon="arrow-downward"></iron-icon> ${math.round(-change)}</span>`);
        }
        else if (change === 0) {
            return new hbs.handlebars.SafeString('<span class="rating-no-change"><iron-icon icon="compare-arrows"></iron-icon> 0</span>');
        }
    });
    hbs.registerHelper('gameDuration', function(duration) {
        return moment.duration(duration, 'seconds').format('m:ss', {
            trim: false
        });
    });
    hbs.registerHelper('gameDominanceScore', function(game) {
        if (game.stats.dominanceScore > 0) {
            return `${game.stats.dominanceScore} (${(HIDE_CAPTAINS || !game.teams[0].captain) ? game.teams[0].faction : game.teams[0].captain.alias})`;
        }
        else if (game.stats.dominanceScore < 0) {
            return `${-1 * game.stats.dominanceScore} (${(HIDE_CAPTAINS || !game.teams[1].captain) ? game.teams[1].faction : game.teams[1].captain.alias})`;
        }
        else {
            return `${game.stats.dominanceScore} (tied)`;
        }
    });
    hbs.registerHelper('canWatchGame', function(status, watch) {
        return watch && status === 'live';
    });

    self.updateUserGames = async function updateUserGames(user) {
        let userID = helpers.getDocumentID(user);

        /* eslint-disable lodash/prefer-lodash-method */
        let games = await database.Game.find({
            $or: [{
                'teams.captain': userID
            }, {
                'teams.composition.players.user': userID
            }]
        }).exec();
        /* eslint-enable lodash/prefer-lodash-method */

        await self.updateGameCache(...games);
    };

    self.getGamePage = async function getGamePage(game) {
        if (!(await cache.existsAsync(`gamePage-${helpers.getDocumentID(game)}`))) {
            await self.updateGameCache(game);
        }

        return JSON.parse(await cache.getAsync(`gamePage-${helpers.getDocumentID(game)}`));
    };

    app.get('/game/:id', async function(req, res) {
        let gamePage = await self.getGamePage(req.params.id);

        if (gamePage) {
            res.render('game', gamePage);
        }
        else {
            res.status(HttpStatus.NOT_FOUND).render('notFound');
        }
    });

    app.get('/games', async function(req, res) {
        res.render('recentGamesList', {
            games: await getGameList(self.isUserAdmin(req.user))
        });
    });

    self.processSubstituteRequestsUpdate();

    fs.writeFileSync(path.resolve(__dirname, '../ratings/settings.cfg'), `[config]\nconnect: ${MONGODB_URL}\ndb: ${database.Rating.db.name}\nratingBase: ${RATING_BASE}\n`);
};
