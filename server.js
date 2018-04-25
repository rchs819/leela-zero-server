require('./classes/prototypes.js');
const moment = require('moment');
const express = require('express');
const fileUpload = require('express-fileupload');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs-extra');
const MongoClient = require('mongodb').MongoClient;
const Long = require('mongodb').Long;
const ObjectId = require('mongodb').ObjectID;
const zlib = require('zlib');
const converter = require('hex2dec');
const Cacheman = require('cacheman');
const app = express();
const Busboy = require('busboy');
const weight_parser = require('./classes/weight_parser.js');
const rss_generator = require('./classes/rss_generator.js');
const os = require("os");
const util = require("util");
const path = require("path");

/**
 * Utilities
 */
const {
    network_exists,
    checksum,
    seed_from_mongolong,
    CalculateEloFromPercent,
    objectIdFromDate,
    log_memory_stats,
    SPRT,
    LLR,
    asyncMiddleware
} = require('./classes/utilities.js');

var auth_key = String(fs.readFileSync(__dirname + "/auth_key")).trim();

var cacheIP24hr = new Cacheman('IP24hr');
var cacheIP1hr = new Cacheman('IP1hr');
var cachematches = new Cacheman('matches');

var fastClientsMap = new Map;

app.set('view engine', 'pug')

// This shouldn't be needed but now and then when I restart test server, I see an uncaught ECONNRESET and I'm not sure
// where it is coming from. In case a server restart did the same thing, this should prevent a crash that would stop nodemon.
//
// It was a bug in nodemon which has now been fixed. It is bad practice to leave this here, eventually remove it.
//
process.on('uncaughtException', (err) => {
    console.error('Caught exception: ' + err);
});

// https://blog.tompawlak.org/measure-execution-time-nodejs-javascript

var counter;
var best_network_mtimeMs = 0;
var best_network_hash_promise = null;
var db;

// TODO Make a map to store pending match info, use mapReduce to find who to serve out, only
// delete when SPRT fail or needed games have all arrived? Then we can update stats easily on
// all matches except just the current one (end of queue).
//
var pending_matches = [];
var MATCH_EXPIRE_TIME = 30 * 60 * 1000; // matches expire after 30 minutes. After that the match will be lost and an extra request will be made.



function get_options_hash (options) {
    if (options.visits) {
        return checksum("" + options.visits + options.resignation_percent + options.noise + options.randomcnt).slice(0,6);
    } else {
        return checksum("" + options.playouts + options.resignation_percent + options.noise + options.randomcnt).slice(0,6);
    }
};

async function get_fast_clients () {
    return new Promise( (resolve, reject) => {
        db.collection("games").aggregate( [
            { $match: { _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60)}}},
            { $group: { _id: "$ip", total: { $sum: 1 }}},
            { $match: { total: { $gt: 4 }}}
        ] ).forEach( (match) => {
            fastClientsMap.set(match._id, true);
        }, (err) => {
            if (err) {
                console.error("Error fetching matches: " + err);
                return reject(err);
            }
        });

        resolve();
    });
};

//  db.matches.aggregate( [ { "$redact": { "$cond": [ { "$gt": [ "$number_to_play", "$game_count" ] }, "$$KEEP", "$$PRUNE" ] } } ] )
//
async function get_pending_matches () {
    pending_matches = [];

    return new Promise( (resolve, reject) => {
        db.collection("matches").aggregate( [
            { "$redact": { "$cond":
                [
                    { "$gt": [ "$number_to_play", "$game_count" ] },
                    "$$KEEP", "$$PRUNE"
                ] } }
        ] ).sort({_id:-1}).forEach( (match) => {
            match.requests = []; // init request list.

            // Client only accepts strings for now
            //
            Object.keys(match.options).map( (key, index) => {
                match.options[key] = String(match.options[key]);
            });

            // If SPRT=pass use unshift() instead of push() so "elo only" matches go last in priority
            //
            switch(SPRT(match.network1_wins, match.network1_losses)) {
                case false:
                    break;
                case true:
                    pending_matches.unshift( match );
                    console.log("SPRT: Unshifting: " + JSON.stringify(match));
                    break;
                default:
                    pending_matches.push( match );
                    console.log("SPRT: Pushing: " + JSON.stringify(match));
            }
        }, (err) => {
            if (err) {
                console.error("Error fetching matches: " + err);
                return reject(err);
            }
        });
        resolve();
    });
};



async function get_best_network_hash () {
    // Check if file has changed. If not, send cached version instead.
    //
    return fs.stat(__dirname + '/network/best-network.gz')
    .then((stats) => {
        if (!best_network_hash_promise || best_network_mtimeMs != stats.mtimeMs) {
            best_network_mtimeMs = stats.mtimeMs;

            best_network_hash_promise = new Promise( (resolve, reject) => {
                log_memory_stats("best_network_hash_promise begins");

                var rstream = fs.createReadStream(__dirname + '/network/best-network.gz');
                var gunzip = zlib.createGunzip();
                var hash = crypto.createHash('sha256')

                hash.setEncoding('hex');

                log_memory_stats("Streams prepared");

                rstream
                .pipe(gunzip)
                .pipe(hash)
                .on('error', () => {
                    console.error("Error opening/gunzip/hash best-network.gz: " + err);
                    err => reject(err);
                })
                .on('finish', () => {
                    var best_network_hash = hash.read();
                    log_memory_stats("Streams completed: " + best_network_hash);
                    resolve(best_network_hash);
                });
            });

        }

        return best_network_hash_promise;
    })
    .catch(err => console.error(err));
};



var QUEUE_BUFFER = 25;
var PESSIMISTIC_RATE = 0.2;



app.enable('trust proxy');

app.use(bodyParser.urlencoded({extended: true}));
app.use(/\/((?!submit-network).)*/, fileUpload());

app.use('/view/player', express.static('static/eidogo-player-1.2/player'));
app.use('/viewmatch/player', express.static('static/eidogo-player-1.2/player'));
app.use('/view/wgo', express.static('static/wgo'));
app.use('/viewmatch/wgo', express.static('static/wgo'));
app.use('/static', express.static('static', { maxage: '365d', etag: true }));

// This is async but we don't need it to start the server. I'm calling it during startup so it'll get the value cached right away
// instead of when the first /best-network request comes in, in case a lot of those requests come in at once when server
// starts up.
get_best_network_hash().then( (hash) => console.log("Current best hash " + hash) );

setInterval( () => {
    get_fast_clients()
    .then()
    .catch();
}, 1000 * 60 * 10);

var last_match_db_check = Date.now();

setInterval( () => {
    var now = Date.now();

    // In case we have no matches scheduled, we check the db.
    //
    if (pending_matches.length === 0 && now > last_match_db_check + 30 * 60 * 1000) {
        console.log("No matches scheduled. Updating pending list.");

        last_match_db_check = now;

        get_pending_matches()
        .then()
        .catch();
    }
}, 1000 * 60 * 1);

MongoClient.connect('mongodb://localhost/test', (err, database) => {
    if (err) return console.log(err);

    db = database;

    db.collection("networks").count()
    .then((count) => {
        console.log ( count + " networks.");
    });

    db.collection("networks").aggregate( [
        {
            $group: {
                _id: null,
                total: { $sum: "$game_count" }
            }
        }
    ], (err, res) => {
        if (err) console.log( err );

        get_fast_clients()
        .then()
        .catch();

        get_pending_matches()
        .then()
        .catch();

        counter =  res[0] && res[0].total;
        console.log ( counter + " games.");

        app.listen(8080, () => {
            console.log('listening on 8080')
        });

        // Listening to both ports while /next people are moving over to real server adddress
        //
        // app.listen(8081, () => {
        //    console.log('listening on 8081')
        // });
    });
});

// Obsolete
//
app.use('/best-network-hash', asyncMiddleware( async (req, res, next) => {
    var hash = await get_best_network_hash();

    res.write(hash);
    res.write("\n");
    // Can remove if autogtp no longer reads this. Required client and leelza versions are in get-task now.
    res.write("11");
    res.end();
}));

// Server will copy a new best-network to the proper location if validation testing of an uploaded network shows
// it is stronger than the prior network. So we don't need to worry about locking the file/etc when uploading to
// avoid an accidential download of a partial upload.
//
// This is no longer used, as /network/ is served by nginx and best-network.gz downloaded directly from it
//
app.use('/best-network', asyncMiddleware( async (req, res, next) => {
    var hash = await get_best_network_hash();
    var readStream = fs.createReadStream(__dirname + '/network/best-network.gz');

    readStream.on('error', (err) => {
        res.send("Error: " + err);
        console.error("ERROR /best-network : " + err);
    });

    readStream.on('open', () => {
        res.setHeader('Content-Disposition', 'attachment; filename=' + hash + ".gz");
        res.setHeader('Content-Transfer-Encoding', 'binary');
        res.setHeader('Content-Type', 'application/octet-stream');
    });

    readStream.pipe(res);

    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " downloaded /best-network");
}));

app.post('/request-match', (req, res) => {
    // "number_to_play" : 400, "options" : { "playouts" : 1600, "resignation_percent" : 1, "randomcnt" : 0, "noise" : "false" }

    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send('Incorrect key provided.');
    }

    if (!req.body.network1)
        return res.status(400).send('No network1 hash specified.');
    else if (!network_exists(req.body.network1))
        return res.status(400).send('network1 hash not found.');

    if (!req.body.network2)
        req.body.network2 = null;
    else if (!network_exists(req.body.network2))
        return res.status(400).send('network2 hash not found.');

    // TODO Need to support new --visits flag as an alternative to --playouts. Use visits if both are missing? Don't allow both to be set.
    //
    if (req.body.playouts && req.body.visits)
        return res.status(400).send('Please set only playouts or visits, not both');

    if (!req.body.playouts && !req.body.visits)
        //req.body.playouts = 1600;
        req.body.visits = 3200;
        //return res.status(400).send('No playouts specified.');

    if (!req.body.resignation_percent)
        req.body.resignation_percent = 5;
        //return res.status(400).send('No resignation_percent specified.');

    if (!req.body.noise)
        req.body.noise = false;
        //return res.status(400).send('No noise specified.');

    if (!req.body.randomcnt)
        req.body.randomcnt = 0;
        //return res.status(400).send('No randomcnt specified.');

    if (!req.body.number_to_play)
        req.body.number_to_play = 400;
        //return res.status(400).send('No number_to_play specified.');

    var options = { "resignation_percent": Number(req.body.resignation_percent),
        "randomcnt": Number(req.body.randomcnt),
        "noise": String(req.body.noise) };

    if (req.body.playouts) {
        options.playouts = Number(req.body.playouts);
    }

    if (req.body.visits) {
        options.visits = Number(req.body.visits);
    }

    // Usage:
    //   - schedule a Test match, set is_test=true
    //   curl -F is_test=true <other params>
    //
    //   - schedule a Normal match, leave out the flag
    //   curl  <other params>
    //
    if (req.body.is_test === 'true')
        req.body.is_test = true;
    else
        req.body.is_test = false;

    var match = { "network1": req.body.network1,
        "network2": req.body.network2, "network1_losses": 0,
        "network1_wins": 0,
        "game_count": 0, "number_to_play": Number(req.body.number_to_play),
        "is_test" : req.body.is_test,
        "options": options, "options_hash": get_options_hash(options) };

    db.collection("matches").insertOne( match )
    .then( () => {
        // Client only accepts strings for now
        Object.keys(match.options).map( (key, index) => {
            match.options[key] = String(match.options[key]);
        });

        match.requests = []; // init request list.
        pending_matches.unshift( match );

        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " Match added!");
        res.send((match.is_test ? "Test" : "Regular") + " Match added!\n");
        console.log("Pending is now: " + JSON.stringify(pending_matches));
    } )
    .catch( (err) => {
        console.error(req.ip + " (" + req.headers['x-real-ip'] + ") " + " ERROR: Match addition failed: " + err);
        res.send("ERROR: Match addition failed\n");
    } );
});

// curl -F 'weights=@zero.prototxt' -F 'training_count=175000' http://localhost:8080/submit-network
//
// Detect if network already exists and if so, inform the uploader and don't overwrite?
// So we don't think the network is newer than it really is. Actually, upsert shouldn't change
// the ObjectID so date will remain original insertion date.
//
app.post('/submit-network', asyncMiddleware((req, res, next) => {
    log_memory_stats("submit network start");
    var busboy = new Busboy({ headers: req.headers });

    req.body = {};

    var file_promise = null;

    req.pipe(busboy).on('field', (name, value) => {
        req.body[name] = value;
    }).on('file', (name, file_stream, file_name) => {
        if (!req.files)
            req.files = {};

        if (name != "weights") {
            // Not the file we expected, flush the stream and do nothing
            //
            file_stream.on('readable', file_stream.read);
            return;
        }

        var temp_file = path.join(os.tmpdir(), file_name);
        // Pipes
        //   - file_stream.pipe(fs_stream)
        //   - file_stream.pipe(gunzip_stream)
        //       - gunzip_stream.pipe(hasher)
        //       - gunzip_stream.pipe(parser)
        file_promise = new Promise((resolve, reject) => {
            var fs_stream = file_stream.pipe(fs.createWriteStream(temp_file)).on('error', reject);
            var gunzip_stream = file_stream.pipe(zlib.createGunzip()).on('error', reject);

            Promise.all([
                new Promise(resolve => {
                    fs_stream.on('finish', () => { resolve({ path: fs_stream.path }) });
                }),
                new Promise(resolve => {
                    var hasher = gunzip_stream.pipe(crypto.createHash('sha256')).on('finish', () => resolve({ hash: hasher.read().toString('hex') }));
                }),
                new Promise(resolve => {
                    var parser = gunzip_stream.pipe(new weight_parser).on('finish', () => resolve(parser.read()));
                })
            ]).then(results => {
                // consolidate results
                results = req.files[name] = Object.assign.apply(null, results);

                // Move temp file to network folder with hash name
                results.path = path.join(__dirname, "network", results.hash + ".gz");
                if (fs.existsSync(temp_file))
                    fs.moveSync(temp_file, results.path, { overwrite: true });

                // We are all done (hash, parse and save file)
                resolve();
            });

        }).catch(err => {
            console.error(err);
            req.files[name] = { error: err };

            // Clean up, flush stream and delete temp file
            file_stream.on('readable', file_stream.read);

            if (fs.existsSync(temp_file))
                fs.removeSync(temp_file);

        });

    }).on('finish', async () => {
        
        await file_promise;

        if (!req.body.key || req.body.key != auth_key) {
            console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");
            return res.status(400).send('Incorrect key provided.');
        }

        if (!req.files || !req.files.weights)
            return res.status(400).send('No weights file was uploaded.');

        if (req.files.weights.error)
            return res.status(400).send(req.files.weights.error.message);

        var set = {
            hash: req.files.weights.hash,
            ip: req.ip,
            training_count: +req.body.training_count || null,
            training_steps: +req.body.training_steps || null,
            filters: req.files.weights.filters,
            blocks: req.files.weights.blocks,
            description: req.body.description,
        };

        // No training count given, we'll calculate it from database.
        //
        if (!set.training_count) {
            var cursor = db.collection("networks").aggregate([{ $group: { _id: 1, count: { $sum: "$game_count" } } }]);
            var totalgames = await cursor.next();
            set.training_count = totalgames.count;
        }

        // Prepare variables for printing messages
        //
        var hash = set.hash,
            filters = set.filters,
            blocks = set.blocks,
            training_count = set.training_count
            ;

        db.collection("networks").updateOne(
            { hash: set.hash },
            { $set: set },
            { upsert: true },
            (err, dbres) => {
                if (err) {
                    res.end(err.message);
                    console.error(err);
                }
                else {
                    var msg = 'Network weights (' + filters + ' x ' + blocks + ') ' + hash + " (" + training_count + ") " + (dbres.upsertedCount == 0 ? "exists" : "uploaded") + "!";
                    res.end(msg);
                    console.log(msg);
                    log_memory_stats('submit network ends');
                }
            }
        );
    });
}));

app.post('/submit-match', asyncMiddleware(async (req, res, next) => {
    if (!req.files) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No files were uploaded.');
        return res.status(400).send('No files were uploaded.');
    }

    if (!req.files.sgf) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No sgf file provided.');
        return res.status(400).send('No sgf file provided.');
    }

    if (!req.body.clientversion) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No clientversion specified.');
        return res.status(400).send('No clientversion specified.');
    }

    if (!req.body.winnerhash) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No winnerhash (network hash for winner) specified.');
        return res.status(400).send('No winnerhash (network hash for winner) specified.');
    }

    if (!req.body.loserhash) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No loserhash (network hash for loser) specified.');
        return res.status(400).send('No loserhash (network hash for loser) specified.');
    }

    if (!req.body.winnercolor) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No winnercolor provided.');
        return res.status(400).send('No winnercolor provided.');
    }

    if (!req.body.movescount) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No movescount provided.');
    }

    if (!req.body.score) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No score provided.');
        return res.status(400).send('No score provided.');
    }

    if (!req.body.options_hash) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No options_hash provided.');
        return res.status(400).send('No options_hash provided.');
    }

    if (!req.body.random_seed) {
        req.body.random_seed = null;
    } else {
        req.body.random_seed = Long.fromString(req.body.random_seed, 10);
    }

    // verify match exists in database
    var match = await db.collection("matches").findOne(
        {
            $or: [
                { network1: req.body.winnerhash, network2: req.body.loserhash },
                { network2: req.body.winnerhash, network1: req.body.loserhash }
            ],
            options_hash: req.body.options_hash,
        }
    );

    // Match not found, abort!!
    if (!match) {
        console.log(`/submit-match for ${req.body.winnerhash.slice(0, 6)} and ${req.body.loserhash.slice(0, 6)} not found`)
        return res.status(400).send("Match not found");
    }

    // calculate sgfhash 
    try {
        const sgfbuffer = await new Promise((resolve, reject) => zlib.unzip(req.files.sgf.data, (err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        }));
        const sgfhash = checksum(sgfbuffer, 'sha256');

        // upload match game to database
        var dbres = await db.collection("match_games").updateOne(
            { sgfhash: sgfhash },
            {
                $set: {
                    ip: req.ip, winnerhash: req.body.winnerhash, loserhash: req.body.loserhash, sgf: sgfbuffer.toString(),
                    options_hash: req.body.options_hash,
                    clientversion: Number(req.body.clientversion), winnercolor: req.body.winnercolor,
                    movescount: (req.body.movescount ? Number(req.body.movescount) : null),
                    score: req.body.score,
                    random_seed: req.body.random_seed
                }
            },
            { upsert: true }
        );

        // Not inserted, we got duplicate sgfhash, abort!
        if (!dbres.upsertedId) {
            console.error("Upload match with duplicate sgf");
            return res.status(400).send("Upload match with duplicate sgf");
        }

        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded match " + sgfhash);
        res.send("Match data " + sgfhash + " stored in database\n");
    } catch (err) {
        console.error("Error processing sgffile in /submit-match: " + err);
        return res.status(400).send("Error with sgf");
    }

    // prepare $inc 
    var $inc = { game_count: 1 };
    if (match.network1 == req.body.winnerhash)
        $inc.network1_wins = 1;
    else
        $inc.network1_losses = 1;

    // save to database using $inc and get modified document
    match = (await db.collection("matches").findOneAndUpdate(
        { _id: match._id },
        { $inc: $inc },
        { returnOriginal: false }  // return modified document 
    )).value;

    // get latest SPRT result
    const sprt_result = SPRT(match.network1_wins, match.network1_losses);
    var pending_match_index = pending_matches.findIndex(m => m._id.equals(match._id));

    // match is found in pending_matches
    if (pending_match_index >= 0) {
        var m = pending_matches[pending_match_index];

        if (sprt_result === false) {
            // remove from pending matches
            console.log("SPRT: Early fail pop: " + JSON.stringify(m));
            pending_matches.splice(pending_match_index, 1)
            console.log("SPRT: Early fail post-pop: " + JSON.stringify(pending_matches));
        } else {
            // remove the match from the requests array.
            var index = m.requests.findIndex(e => e.seed === seed_from_mongolong(req.body.random_seed));
            if (index !== -1) {
                m.requests.splice(index, 1);
            }

            // update stats 
            m.game_count++;
            if (m.network1 == req.body.winnerhash) {
                m.network1_wins++;
            } else {
                m.network1_losses++;
            }

            // Check > 1 since we'll run to 400 even on a SPRT pass, but will do it at end.
            //
            if (sprt_result === true && pending_matches.length > 1) {
                console.log("SPRT: Early pass unshift: " + JSON.stringify(m));
                pending_matches.unshift(pending_matches.splice(pending_match_index, 1));
                console.log("SPRT: Early pass post-unshift: " + JSON.stringify(pending_matches));
            }
        }
    }

    // Lastly, promotion check!!
    // Check if network2 == best_network_hash and if so, check SPRT. If SPRT pass, promote network1 as new best-network.
    // This is for the case where a match comes in to promote us, after it is no longer the active match in queue.
    //
    var best_network_hash = await get_best_network_hash();
    if (
        // Best network has lost
        req.body.loserhash == best_network_hash
        // This is not a test match
        && !match.is_test
        // SPRT passed OR it has reach 55% after 400 games (stick to the magic number)
        && (
            sprt_result === true
            || (match.game_count >= 400 && match.network1_wins / match.game_count >= 0.55)
        )) {

        fs.copyFileSync(__dirname + '/network/' + req.body.winnerhash + '.gz', __dirname + '/network/best-network.gz');
        console.log("New best network copied from (normal check): " + __dirname + '/network/' + req.body.winnerhash + '.gz');
    }

    cachematches.clear(() => { console.log("Cleared match cache."); });
}));

// curl -F 'networkhash=abc123' -F 'file=@zero.prototxt' http://localhost:8080/submit
// curl -F 'networkhash=abc123' -F 'sgf=@zero.prototxt' -F 'trainingdata=@zero.prototxt' http://localhost:8080/submit

app.post('/submit', (req, res) => {
    if (!req.files)
        return res.status(400).send('No files were uploaded.');

    if (!req.body.networkhash)
        return res.status(400).send('No network hash specified.');

    if (!req.files.sgf)
        return res.status(400).send('No sgf file provided.');

    if (!req.files.trainingdata)
        return res.status(400).send('No trainingdata file provided.');

    if (!req.body.random_seed) {
        req.body.random_seed = null;
    } else {
        req.body.random_seed = Long.fromString(req.body.random_seed, 10);
    }

    let clientversion;

    if (!req.body.clientversion) {
      clientversion = 0;
    } else {
      clientversion = req.body.clientversion;
    }

    var networkhash = req.body.networkhash;
    var trainingdatafile;
    var sgffile;
    var sgfhash;

    var sgfbuffer = Buffer.from(req.files.sgf.data);
    var trainbuffer = Buffer.from(req.files.trainingdata.data);

    if (req.ip == "xxx") {
        res.send("Game data " + sgfhash + " stored in database\n");
        console.log("FAKE/SPAM reply sent to " + "xxx" + " (" + req.headers['x-real-ip'] + ")");
    } else {

    zlib.unzip(sgfbuffer, (err, sgfbuffer) => {
        if (err) {
            console.error("Error decompressing sgffile: " + err);
        } else {
            sgffile = sgfbuffer.toString();
            sgfhash = checksum(sgffile, 'sha256');

            zlib.unzip(trainbuffer, (err, trainbuffer) => {
                if (err) {
                    console.error("Error decompressing trainingdata: " + err);
                } else {
                    trainingdatafile = trainbuffer.toString();

                    db.collection("games").updateOne(
                        { sgfhash: sgfhash },
                        { $set: { ip: req.ip, networkhash: networkhash, sgf: sgffile, options_hash: req.body.options_hash,
                                    movescount: (req.body.movescount ? Number(req.body.movescount) : null),
                                data: trainingdatafile, clientversion: Number(clientversion),
                                    winnercolor: req.body.winnercolor, random_seed: req.body.random_seed }},
                  { upsert: true },
                        (err, dbres) => {
                            // Need to catch this better perhaps? Although an error here really is totally unexpected/critical.
                            //
                            if (err) {
                                console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded game #" + counter + ": " + sgfhash + " ERROR: " + err);
                                res.send("Game data " + sgfhash + " stored in database\n");
                            } else {
                                counter++;
                                console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded game #" + counter + ": " + sgfhash);
                                res.send("Game data " + sgfhash + " stored in database\n");
                            }
                        }
                    );

                    db.collection("networks").updateOne(
                        { hash: networkhash },
                        { $inc: { game_count: 1 } },
                        { },
                        (err, dbres) => {
                            if (err) {
                                console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded game #" + counter + ": " + sgfhash + " INCREMENT ERROR: " + err);
                            } else {
                                //console.log("Incremented " + networkhash);
                            }
                        }
                    );
                }
            });
        }
    });

    }
});

app.get('/network-profiles/:hash(\\w+)/:tab(matches|self-play)?', asyncMiddleware(async (req, res, next) => {
    var network = await db.collection("networks")
        .findOne({ hash: req.params.hash });

    if (!network) {
        return res.status(404).render("404");
    }

    var networkID = null;

    // If it's one of the best network, then find it's #
    if (network.game_count > 0 || network.hash == get_best_network_hash()) {
        networkID = await db.collection("networks")
            .count({
                $and: [
                    { _id: { $lt: network._id } },
                    { game_count: { $gt: 0 } }
                ]
            });
    }

    network.networkID = networkID;

    await new Promise(async (resolve, reject) => {
        var avatar_folder = path.join(__dirname, 'static', 'networks');

        if (!await fs.pathExists(avatar_path)) {
            await fs.mkdirs(avatar_folder);
        }
        
        var avatar_path = path.join(avatar_folder, network.hash + '.png');

        if (!await fs.pathExists(avatar_path)) {
            var retricon = require('retricon-without-canvas');
            retricon(network.hash, { pixelSize: 70, imagePadding: 35, bgColor: '#F0F0F0' })
                .pngStream()
                .pipe(fs.createWriteStream(avatar_path))
                .on('finish', () => {
                    resolve();
                });
        } else {
            resolve();
        }
    });
    var pug_data = {
        network,
        http_host: req.protocol + '://' + req.get('host')
    };

    if(!req.params.tab || req.params.tab == "matches") {
        pug_data.matches = await db.collection("matches")
            .aggregate([ 
                { "$match": { $or : [{ network1 : network.hash }, { network2 : network.hash }] } },
                { "$lookup": { "localField": "network2", "from": "networks", "foreignField": "hash", "as": "network2" } }, { "$unwind": "$network2" }, 
                { "$lookup": { "localField": "network1", "from": "networks", "foreignField": "hash", "as": "network1" } }, { "$unwind": "$network1" }, 
                { "$sort": { _id: -1 } }, 
                { "$limit": 100 } 
            ]).toArray();
    } else {
        pug_data.self_play = [];
    }
    res.render('networks/profile', pug_data);
}));

app.get('/rss', asyncMiddleware(async (req, res, next) => {
    var rss_path = path.join(__dirname, 'static', 'rss.xml')
        , best_network_path = path.join(__dirname, 'network', 'best-network.gz')
        , should_generate = true
        , http_host = req.protocol + '://' + req.get('host');

    var rss_exists = await fs.pathExists(rss_path);

    if (rss_exists) {
        best_network_mtimeMs = (await fs.stat(best_network_path)).mtimeMs;
        rss_mtimeMs = (await fs.stat(rss_path)).mtimeMs;

        // We have new network promoted since rss last generated
        should_generate = best_network_mtimeMs > rss_mtimeMs;
    }

    if (should_generate || req.query.force) {
        best_hash = get_best_network_hash();
        var networks = await db.collection("networks")
            .find({ $or: [{ game_count: { $gt: 0 } }, { hash: best_hash }] })
            .sort({ _id: 1 })
            .toArray();

        var rss_xml = new rss_generator().generate(networks, http_host);

        await fs.writeFile(rss_path, rss_xml);
    }

    res.setHeader("Content-Type", "application/rss+xml");
    res.sendFile(rss_path);
}));

app.get('/',  asyncMiddleware( async (req, res, next) => {
    console.log(req.ip + " Sending index.html");

    var network_table = "<table class=\"networks-table\" border=1><tr><th colspan=6>Best Network Hash</th></tr>\n";
    network_table += "<tr><th>#</th><th>Upload Date</th><th>Hash</th><th>Architecture</th><th>Games</th><th>Training #</th></tr>\n";

    var styles = "";
    var iprecentselfplayhash = "";
    var mostrecentselfplayhash = "";

    var cursor = db.collection("networks").aggregate( [ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
    var totalgames = await cursor.next();

    var best_network_hash = await get_best_network_hash();

    Promise.all([
        cacheIP24hr.wrap('IP24hr', '5m', () => { return Promise.resolve(
        db.collection("games").distinct('ip', { _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60 * 24) } })
        )})
        .then((list) => {
            return (list.length + " clients in past 24 hours, ");
        }),
        cacheIP1hr.wrap('IP1hr', '30s', () => { return Promise.resolve(
        db.collection("games").distinct('ip', { _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60) } })
        )})
        .then((list) => {
            return (list.length + " in past hour.<br>");
        }),
        db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60 * 24) } }).count()
        .then((count) => {
            return (counter + " total selfplay games. (" + count + " in past 24 hours, ");
        }),
        db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60) } }).count()
        .then((count) => {
            return (count + " in past hour.)<br>");
        }),
        db.collection("match_games").find().count()
        .then((count) => {
            return (count + " total match games. (");
        }),
        db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60 * 24) } }).count()
        .then((count) => {
            return (count + " match games in past 24 hours, ");
        }),
        db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60) } }).count()
        .then((count) => {
            return (count + " in past hour.)<br>");
        }),
        db.collection("networks").aggregate([
            { $match: { game_count: { $gt: 0 } } },
            { $group: { _id: 1, networks: { $push: { _id: "$_id", hash: "$hash", game_count: "$game_count", training_count: "$training_count", filters: "$filters", blocks: "$blocks" } } } },
            { $unwind: { path: '$networks', includeArrayIndex: 'networkID' } },
            { $project: { _id: "$networks._id", hash: "$networks.hash", game_count: "$networks.game_count", training_count: "$networks.training_count", filters: "$networks.filters", blocks: "$networks.blocks", networkID: 1 } },
            { $sort: { networkID: -1 } },
            { $limit: 10000 }
        ])
        //db.collection("networks").find({ game_count: { $gt: 0 } }, { _id: 1, hash: 1, game_count: 1, training_count: 1}).sort( { _id: -1 } ).limit(100)
        .toArray()
        .then((list) => {
            for (let item of list) {
                var itemmoment = new moment(item._id.getTimestamp());

                totalgames.count -= item.game_count;

                network_table += "<tr><td>"
                    + item.networkID
                    + "</td><td>"
                    + itemmoment.utcOffset(1).format("YYYY-MM-DD HH:mm")
                    + "</td><td><a href=\"/networks/"
                    + item.hash
                    + ".gz\">"
                    + item.hash.slice(0,8)
                    + "</a></td><td>"
                    + (item.filters && item.blocks ? `${item.filters}x${item.blocks}` : "TBD")
                    + "</td><td>"
                    + item.game_count
                    + "</td><td>"
                    + ( (item.training_count === 0 || item.training_count) ? item.training_count : totalgames.count)
                    + "</td></tr>\n";
            }

            network_table += "</table>\n";
            return "";
        }),
        db.collection("games").find({ ip: req.ip }, { _id: 0, sgfhash: 1 }).hint( "ip_-1__id_-1" ).sort( { _id: -1 } ).limit(1).toArray()
        .then((game) => {
            if (game[0]) {
                iprecentselfplayhash = game[0].sgfhash;
            }

            return "";
        }),
        db.collection("match_games").find(
            { winnerhash: best_network_hash },
            { _id: 0, winnerhash: 1, loserhash: 1, sgfhash: 1 }
        ).sort( { _id: -1 } ).limit(1).toArray()
        .then((game) => {
            if (game[0]) {
                return "<br>"
                    + "View most recent match win by best network " + game[0].winnerhash.slice(0,8) + " vs " + game[0].loserhash.slice(0,8) + ": "
                    + "[<a href=\"/viewmatch/" + game[0].sgfhash + "?viewer=eidogo\">EidoGo</a> / "
                    + "<a href=\"/viewmatch/" + game[0].sgfhash + "?viewer=wgo\">WGo</a>] "
                    + "<br>";
            } else {
                return "";
            }
        }),
        db.collection("games").find({}, { _id: 0, sgfhash: 1 }).sort( { _id: -1 } ).limit(1).toArray()
        .then((game) => {
            if (game[0]) {
                mostrecentselfplayhash = game[0].sgfhash;
            }

            return "";
        }),
        cachematches.wrap('matches', '1d', () => { return Promise.resolve(
        db.collection("matches").aggregate([ { "$lookup": { "localField": "network2", "from": "networks", "foreignField": "hash", "as": "merged" } }, { "$unwind": "$merged" }, { "$lookup": { "localField": "network1", "from": "networks", "foreignField": "hash", "as": "merged1" } }, { "$unwind": "$merged1" }, { "$sort": { _id: -1 } }, { "$limit": 100 } ])
        .toArray()
        .then((list) => {
            var match_table = "<table class=\"matches-table\" border=1><tr><th colspan=5>Test Matches (100 Most Recent)</th></tr>\n";
            match_table += "<tr><th>Start Date</th><th>Network Hashes</th><th>Wins / Losses</th><th>Games</th><th>SPRT</th></tr>\n";

            for (let item of list) {
                // The aggregate query above should not return any null network2 matches, but let's be safe.
                //
                if (item.network2 === null) continue;

                var win_percent = item.game_count ? (100 * item.network1_wins / item.game_count).toFixed(2) : null;
                var itemmoment = new moment(item._id.getTimestamp());

                if (win_percent) {
                    if (win_percent >= 55) {
                        win_percent = "<b>" + win_percent + "</b>";
                    }
                    win_percent = " (" + win_percent + "%)";
                }

                match_table += "<tr>"
                    + "<td>" + itemmoment.utcOffset(1).format("YYYY-MM-DD HH:mm") + "</td>"
                    + "<td>"
                    + "<div class=\"tooltip\">"
                    + "<a href=\"/networks/" + item.network1 + ".gz\">" + item.network1.slice(0,8) + "</a>"
                    + "<span class=\"tooltiptextleft\">"
                    + item.merged1.training_count.abbr(4)
                    + (item.merged1.training_steps ? "+" + item.merged1.training_steps.abbr(3) : "")
                    + (item.merged1.filters && item.merged1.blocks ? `<br/>${item.merged1.filters}x${item.merged1.blocks}` : "")
                    + (item.merged1.description ? `<br/>${item.merged1.description}` : "")
                    + "</span></div>&nbsp;"
                    + "<div class=\"tooltip\">"
                    + " <a href=\"/match-games/" + item._id + "\">VS</a> "
                    + "<span class=\"tooltiptextright\">"
                    + (item.is_test ? "Test" : "Regular") + " Match"
                    + "</span>"
                    + "</div>&nbsp;"
                    ;

                if (item.network2) {
                    match_table += "<div class=\"tooltip\">"
                        + "<a href=\"/networks/" + item.network2 + ".gz\">" + item.network2.slice(0,8) + "</a>"
                        + "<span class=\"tooltiptextright\">"
                        + item.merged.training_count.abbr(4)
                        + (item.merged.training_steps ? "+" + item.merged.training_steps.abbr(3) : "")
                        + (item.merged.filters && item.merged.blocks ? `<br/>${item.merged.filters}x${item.merged.blocks}` : "")
                        + (item.merged.description ? `<br/>${item.merged.description}` : "")
                        + "</span></div>"
                } else {
                    match_table += "BEST";
                }

                match_table += "</td>"
                    + "<td>" + item.network1_wins + " : " + item.network1_losses +
                        ( win_percent ? win_percent + "</td>" : "</td>")
                    + "<td>" + item.game_count + " / " + item.number_to_play + "</td>"
                    + "<td>";

                switch(SPRT(item.network1_wins, item.network1_losses)) {
                    case true:
                        match_table += "<b>PASS</b>";
                        break;
                    case false:
                        match_table += "<i>fail</i>";
                        break;
                    default:
                        // -2.9444389791664403 2.9444389791664403 == range of 5.88887795833
                        var width = Math.round(100 * (2.9444389791664403 + LLR(item.network1_wins, item.network1_losses, 0, 35)) / 5.88887795833);
                        var color;

                        if (width < 0) {
                            color = "C11B17";
                            width = 0;
                        } else if (width > 100) {
                            color = "0000FF";
                            width = 100;
                        } else {
                            color = "59E817";
                        }

                        styles += ".n" + item.network1.slice(0,8) + "{ width: " + width + "%; background-color: #" + color + ";}\n";
                        match_table += "<div class=\"n" + item.network1.slice(0,8) + "\">&nbsp;</div>";
                }

                match_table += "</td></tr>\n";
            }

            match_table += "</table>\n";
            return [styles, match_table];
        })
        )}),
    ]).then((responses) => {
        var match_and_styles = responses.pop();

        var styles = match_and_styles[0];
        var match_table = match_and_styles[1];

        var page = "<html><head>\n<title>Leela Zero</title>\n";
        page += `<link rel="alternate" type="application/rss+xml" title="Leela Zero Best Networks" href="http://zero.sjeng.org/rss" />`
        page += "<script type=\"text/javascript\" src=\"/static/timeago.js\"></script>\n";
        page += "<style>";
        page += "table.networks-table { float: left; margin-right: 40px; margin-bottom: 20px; }\n";
        page += styles;

        // From https://www.w3schools.com/css/css_tooltip.asp
        //
        page += ".tooltip { position: relative; display: inline-block; border-bottom: 1px dotted black; }\n";

        page += ".tooltip .tooltiptextright { visibility: hidden; width: 130px; background-color: black; color: #fff; text-align: center; border-radius: 6px; padding: 5px 0; position: absolute; z-index: 1; top: -5px; left: 110%; }\n";
        page += " .tooltip .tooltiptextright::after { content: \"\"; position: absolute; top: 50%; right: 100%; margin-top: -5px; border-width: 5px; border-style: solid; border-color: transparent black transparent transparent; }\n";
        page += " .tooltip:hover .tooltiptextright { visibility: visible; }\n";

        page += ".tooltip .tooltiptextleft { visibility: hidden; width: 130px; background-color: black; color: #fff; text-align: center; border-radius: 6px; padding: 5px 0; position: absolute; z-index: 1; top: -5px; right: 110%; }\n";
        page += " .tooltip .tooltiptextleft::after { content: \"\"; position: absolute; top: 50%; left: 100%; margin-top: -5px; border-width: 5px; border-style: solid; border-color: transparent transparent transparent black; }\n";
        page += " .tooltip:hover .tooltiptextleft { visibility: visible; }\n";

        page += "</style>\n";
        page += "</head><body>\n";

        page += "Leela Zero is available from: <a href=\"https://github.com/gcp/leela-zero\">Github</a>.<br>";
        page += "Check out the <a href=\"https://github.com/gcp/leela-zero/blob/master/FAQ.md\">FAQ</a> and ";
        page += "<a href=\"https://github.com/gcp/leela-zero/blob/master/README.md\">README</a>.<br>";
        page += `<br>Networks 93229e15 and 8d9c5e80 are net2net trained 256x20 network tests. Not a bug. <a href="https://github.com/gcp/leela-zero/issues/1113">Info here</a>.<br>\n`;
        page += `<br>Network 6615567e is a net2net trained 128x10 network test. Not a bug. <a href="https://github.com/gcp/leela-zero/issues/965">Info here</a>.<br>\n`;
        page += "Network 1e2b85cf is best_v1 tested as a reference point. It isn't a normal LZ network. Not a bug.<br>\n";
        page += "<br>Autogtp will automatically download better networks once found.<br>";
        page += "Not each trained network will be a strength improvement over the prior one. Patience please. :)<br>";
        page += "Match games are played at full strength (only 3200 visits).<br>";
        page += "Training games are played with some randomness in first 30 moves, and noise all game long.<br>";
        page += "<br>";
        page += "2018-03-24 <a href=\"https://github.com/gcp/leela-zero/releases\">Leela Zero 0.13 + AutoGTP v15</a>. <b>Update required.</b><br>";
        page += "2018-02-19 <a href=\"https://github.com/gcp/leela-zero/releases\">Leela Zero 0.12 + AutoGTP v14</a>. <b>Update required.</b><br>";
        page += "<br>";

        responses.map( response => page += response );

        if (mostrecentselfplayhash) {
            page += "View most recent selfplay training game: ";
            page += "[<a href=\"/view/" + mostrecentselfplayhash + "?viewer=eidogo\">EidoGo</a> / ";
            page += "<a href=\"/view/" + mostrecentselfplayhash + "?viewer=wgo\">WGo</a>] ";
            page += "<br>";
        }

        if (iprecentselfplayhash) {
            page += "View your most recent selfplay training game: ";
            page += "[<a href=\"/view/" + iprecentselfplayhash + "?viewer=eidogo\">EidoGo</a> / ";
            page += "<a href=\"/view/" + iprecentselfplayhash + "?viewer=wgo\">WGo</a>]";
            page += "<br>";
        }

        page += "<br><br>";
        page += "<a href=\"https://sjeng.org/zero/\">Raw SGF files</a>.<br>";
        page += "<a href=\"https://docs.google.com/spreadsheets/d/e/2PACX-1vTsHu7T9vbfLsYOIANnUX9rHAYu7lQ4AlpVIvCfn60G7BxNZ0JH4ulfbADEedPVgwHxaH5MczdH853l/pubchart?oid=286613333&format=interactive\">Original strength graph</a>. (Mostly obsolete.)<br>";
        page += "<br>";
        page += "<iframe width=\"950\" height=\"655\" seamless frameborder=\"0\" scrolling=\"no\" src=\"/static/elo.html\"></iframe>";
        page += "<br><br>Times are in GMT+0100 (CET)<br>\n";
        page += network_table;
        page += match_table;
        page += "</body></html>";
        res.send(page);
    });
}));

function shouldScheduleMatch (req, now) {
  if (!(pending_matches.length && req.params.version!=0 && fastClientsMap.get(req.ip))) {
    return false;
  }

  var match = pending_matches[pending_matches.length - 1];
  var deleted = match.requests.filter(e => e.timestamp < now - MATCH_EXPIRE_TIME).length;
  var oldest = (match.requests.length > 0 ? (now - match.requests[0].timestamp) / 1000 / 60 : 0).toFixed(2);
  match.requests.splice(0, deleted);
  var requested = match.requests.length;
  var needed = how_many_games_to_queue(
                match.number_to_play,
                match.network1_wins,
                match.network1_losses,
                PESSIMISTIC_RATE);
  var result = needed > requested;
  console.log(`Need ${needed} match games. Requested ${requested}, deleted ${deleted}. Oldest ${oldest}m ago. Will schedule ${result ? "match" : "selfplay"}.`);

  return result;
}

app.get('/get-task/:version(\\d+)', asyncMiddleware( async (req, res, next) => {
    var required_client_version = String(15);
    var required_leelaz_version = String("0.13");

    var random_seed = converter.hexToDec( "0x"+crypto.randomBytes(8).toString('hex') ).toString();

    // Pulling this now because if I wait inside the network2==null test, possible race condition if another get-task pops end of array?
    //
    var best_network_hash = await get_best_network_hash();
    var now = Date.now();

    // Track match assignments as they go out, so we don't send out too many. If more needed request them, otherwise selfplay.
    //
    if (shouldScheduleMatch(req, now)) {
        var match = pending_matches[pending_matches.length - 1];
        var task = {"cmd": "match", "required_client_version": required_client_version, "random_seed": random_seed, "leelaz_version" : required_leelaz_version};

        if (match.options.visits) match.options.playouts = "0";

        task.options = match.options;
        task.options_hash = match.options_hash;

        if (match.network2 == null) {
            match.network2 = best_network_hash;

            db.collection("matches").updateOne(
                { network1: match.network1, network2: null, options_hash: match.options_hash },
                { $set: { network2: best_network_hash } },
                { },
                (err, dbres) => {
                    if (err) {
                        console.log("ERROR: /get-task setting network2: " + err);
                        res.send("ERROR: /get-task setting network2: " + err);
                        return;
                    }
                    console.log("Match " + match._id + " set network2 to best: " + match.network2);
            });
        }

        match.game_color = !match.game_color

        if (match.game_color) {
            task.white_hash = match.network1;
            task.black_hash = match.network2;
        } else {
            task.white_hash = match.network2;
            task.black_hash = match.network1;
        }

        res.send(JSON.stringify(task));

        match.requests.push({timestamp: now, seed: random_seed});

        if (match.game_count >= match.number_to_play) pending_matches.pop();

        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " got task: match " + match.network1.slice(0,8) + " vs " + match.network2.slice(0,8) + " " + (match.game_count + match.requests.length) + " of " + match.number_to_play);
//    } else if ( req.params.version==1 && Math.random() > .2 ) {
//        var task = { "cmd": "wait", "minutes": "5" };
//
//        res.send(JSON.stringify(task));
//
//        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " got task: wait");
    } else {
        // {"cmd": "selfplay", "hash": "xxx", "playouts": 1000, "resignation_percent": 3.0}
        var task  = {"cmd": "selfplay", "hash": "", "required_client_version": required_client_version, "random_seed": random_seed, "leelaz_version" : required_leelaz_version};

        // TODO In time we'll change this to a visits default instead of options default, for new --visits command
        //
        //var options = {"playouts": "1600", "resignation_percent": "10", "noise": "true", "randomcnt": "30"};
        var options = {"playouts": "0", "visits": "3201", "resignation_percent": "5", "noise": "true", "randomcnt": "30"};

        if (Math.random() < .2) options.resignation_percent = "0";

        //task.options_hash = checksum("" + options.playouts + options.resignation_percent + options.noise + options.randomcnt).slice(0,6);
        task.options_hash = get_options_hash(options);
        task.options = options;

        task.hash = best_network_hash;

        res.send(JSON.stringify(task));

        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " got task: selfplay");
    }
}));

app.get('/view/:hash(\\w+)', (req, res) => {
    Promise.all([
        db.collection("games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
        .then((game) => {
            return (game.sgf);
        }),
    ]).then((responses) => {
        sgf = responses[0].replace(/(\n|\r)+/g, '');

        switch (req.query.viewer) {
            case "eidogo":
                res.render('eidogo', { title: "View training game " + req.params.hash, sgf: sgf });
                break;
            case "wgo":
                res.render('wgo', { title: "View training game " + req.params.hash, sgf: sgf });
                break;
            default:
                res.render('eidogo', { title: "View training game " + req.params.hash, sgf: sgf });
        }
    }).catch( err => {
        res.send("No selfplay game was found with hash " + req.params.hash);
    });
});

app.get('/match-games/:matchid(\\w+)', (req, res) => {
    if (!req.params.matchid) {
        res.send("matchid missing");
        return;
    }

    var ipMap = new Map();

    db.collection("matches").findOne({ "_id": new ObjectId(req.params.matchid) })
        .then((match) => {
            db.collection("match_games").aggregate([
                {
                    "$match": {
                        "$or": [
                            { winnerhash: match.network1, loserhash: match.network2, options_hash: match.options_hash },
                            { winnerhash: match.network2, loserhash: match.network1, options_hash: match.options_hash }
                        ]
                    }
                },
                { "$sort": { _id: 1 } }
            ]).toArray()
                .then((list) => {
                    for (let item of list) {
                        if (ipMap.get(item.ip) == null) {
                            ipMap.set(item.ip, ipMap.size + 1);
                        }
                        // replace IP here before going to pug view
                        item.ip = ipMap.get(item.ip);
                    }

                    // render pug view match-games
                    res.render("match-games", { data: list });
                }).catch(err => {
                    res.send("No matches found for match " + req.params.matchid);
                });
        }).catch(err => {
            res.send("No match found for id " + req.params.hash);
        });
});

app.get('/viewmatch/:hash(\\w+).sgf', (req, res) => {
    Promise.all([
        db.collection("match_games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
        .then((game) => {
            return (game.sgf);
        }),
    ]).then((responses) => {
        sgf = responses[0].replace(/(\n|\r)+/g, '');

        res.setHeader("Content-Disposition", "attachment; filename=\"" + req.params.hash + ".sgf\"");
        res.setHeader("Content-Type", "application/x-go-sgf");
        res.send(sgf);
    }).catch( err => {
        res.send("No match was found with hash " + req.params.hash);
    });
});

app.get('/viewmatch/:hash(\\w+)', (req, res) => {
    Promise.all([
        db.collection("match_games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
        .then((game) => {
            return (game.sgf);
        }),
    ]).then((responses) => {
        sgf = responses[0].replace(/(\n|\r)+/g, '');

        switch (req.query.viewer) {
            case "eidogo":
                res.render('eidogo', { title: "View training game " + req.params.hash, sgf: sgf });
                break;
            case "wgo":
                res.render('wgo', { title: "View match " + req.params.hash, sgf: sgf });
                break;
            default:
                res.render('eidogo', { title: "View training game " + req.params.hash, sgf: sgf });
        }
    }).catch( err => {
        res.send("No match was found with hash " + req.params.hash);
    });
});


app.get('/data/elograph.json',  asyncMiddleware( async (req, res, next) => {
    // cache in `cachematches`, so when new match result is uploaded, it gets cleared as well
    var json = await cachematches.wrap("elograph", "1d", async () => {
    console.log("fetching data for elograph.json, should be called once per day or when `cachematches` is cleared")

    var cursor = db.collection("networks").aggregate( [ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
    var totalgames = await cursor.next();

    return Promise.all([
        db.collection("networks").find().sort({_id: -1}).toArray(),
        db.collection("matches").aggregate([
            { "$lookup": { "localField": "network2", "from": "networks", "foreignField": "hash", "as": "merged" } },
            { "$unwind": "$merged" },
            { "$sort": { "merged._id": 1 } }
        ]).toArray()
    ]).then((dataArray) => {
        var elograph_data;

        // prepare networks
        var networks = dataArray[0].map(item => {
            totalgames.count -= item.game_count || 0;

            return {
                "hash": item.hash, 
                "game_count": item.game_count,
                "net": (item.training_count === 0 || item.training_count) ? item.training_count : totalgames.count, // mycount
                "best": !!item.game_count // !! boolean cast
            };
        });

        // prepare ratingsMap
        var ratingsMap = new Map();
        dataArray[1].forEach(match => {
            var network2_rating = ratingsMap.get(match.network2) ? ratingsMap.get(match.network2).rating : 0;
            var sprt;
            var elo;

            // TODO If no ELO info, make rating -1 for graph to just hide it instead of assuming same elo as network 2.
            //
            if (match.network1_wins > 0 && match.network1_losses > 0) {
                elo = CalculateEloFromPercent( match.network1_wins / match.game_count );
            } else {
                var fakecount = match.game_count;
                var fakewins = match.network1_wins;

                if (fakewins == 0) {
                    fakewins++;
                    fakecount++;
                }

                if (match.network1_losses == 0) {
                    fakecount++;
                }

                elo = CalculateEloFromPercent( fakewins / fakecount );
            }

            switch (SPRT(match.network1_wins, match.network1_losses)) {
                case false:
                    sprt = "FAIL";
                    break;

                case true:
                    sprt = "PASS";
                    break;

                default:
                    sprt = "???"
            }

            var info =  {
                "rating": elo + network2_rating,
                "sprt": sprt
            };

            ratingsMap.set(match.network1, info);
        });

        // prepare json result
        var json = networks.map((item) => {
            var rating;

            if (ratingsMap.get(item.hash) === undefined) {
                rating = item.best === "true" ? 0 : -1;
            } else {
                rating = Math.round(ratingsMap.get(item.hash).rating);
            }
            var sprt = ratingsMap.get(item.hash) ? ratingsMap.get(item.hash).sprt : "???";
            var result_item = {
                "rating": Math.max(0.0, rating),
                "net": Math.max(0.0, Number(item.net + rating/100000)),
                "sprt": sprt,
                "hash": item.hash.slice(0,6),
                "best": item.best
            };
            return result_item;
        });

        // shortcut for sending json result using `JSON.stringify`
        // and set `Content-Type: application/json`
        return json;
    }).catch( err => {
        console.log("ERROR data/elograph.json: " + err);
        res.send("ERROR data/elograph.json: " + err);
    });

    });

    res.json(json);
}));

// Catch all, return 404 page not found
app.get('*', asyncMiddleware(async (req, res, next) => {
    return res.status(404).render("404");
}));
