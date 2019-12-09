'use strict';

const Chance = require('chance');
const config = require('config');
const crypto = require('crypto');
const debug = require('debug')('pugchamp:util:server');
const EventEmitter = require('events');
const express = require('express');
const fs = require('fs');
//const g = require('idle-gc');
const hbs = require('hbs');
const heapdump = require('heapdump');
const http = require('http');
const ms = require('ms');
const passport = require('passport');
const path = require('path');
const serveStatic = require('serve-static');
const session = require('express-session');
const socketIO = require('socket.io');
const util = require('util');
const MongoStore = require('connect-mongo')(session);

var PugChamp = function() {
    EventEmitter.call(this);
};
util.inherits(PugChamp, EventEmitter);

var app = express();
var cache = require('./cache');
var chance = new Chance(crypto.randomBytes(4).readInt32LE());
var database = require('./database');
var server = http.Server(app);
var io = socketIO(server);
var self = new PugChamp();

app.set('view engine', 'hbs');

app.set('trust proxy', 'loopback');

hbs.registerPartials(path.resolve(__dirname, 'views', 'partials'));

app.use(session({
    cookie: {
        maxAge: ms(config.get('server.sessionExpiration'))
    },
    resave: false,
    saveUninitialized: false,
    secret: config.get('server.sessionSecret'),
    store: new MongoStore({
        mongooseConnection: database.mongoose.connection
    })
}));
app.use(passport.initialize());
app.use(passport.session());

app.use('/', serveStatic(path.resolve(__dirname, 'public')));
app.use('/components', serveStatic(path.resolve(__dirname, 'bower_components')));

require('./modules')(app, cache, chance, database, io, self);

app.use(function(err, req, res, next) {
    debug(`Express caught error: ${err.stack || err}`);
    res.render('error');
});

try {
    fs.unlinkSync(config.get('server.listen'));
}
catch (err) {
    // ignore
}

server.listen(config.get('server.listen'));

try {
    fs.chmodSync(config.get('server.listen'), '775');
}
catch (err) {
    // ignore
}

//g.start();

process.on('exit', function() {
    server.close();
});
