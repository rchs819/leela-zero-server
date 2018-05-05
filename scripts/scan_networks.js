const MongoClient = require('mongodb').MongoClient;
const fs = require("fs-extra");
const zlib = require("zlib");
const path = require('path');
var weight_parser = require('../classes/weight_parser.js');


(async () => {
    try {
        var db = await MongoClient.connect('mongodb://localhost/test');

        // Find networks that didn't have `filters` or `blocks`
        //
        var networks = await db.collection("networks").find(
            {
                $or: [
                    { filters: { $in: [null, 0] } },
                    { blocks: { $in: [null, 0] } },
                ]
            }
        ).toArray();

        console.log(`Found ${networks.length} networks need re-scanning.`)

        var network_folder = path.join(__dirname, "..", "network");

        // Start Re-Scanning
        for (var network of networks) {
            var network_path = path.join(network_folder, `${network.hash}.gz`);

            if (!fs.existsSync(network_path)) {
                console.log(`Network ${network.hash} not found`);
                continue;
            }

            var parser = new weight_parser;

            var architecture = await new Promise((resolve) => {
                fs.createReadStream(network_path)
                    .pipe(zlib.createGunzip())
                    .pipe(parser)
                    .on('finish', () => resolve(parser.read()))
            });

            await db.collection("networks").updateOne(
                { _id: network._id },
                { $set: architecture }
            );

            console.log(`Network ${network.hash} is ${architecture.filters}x${architecture.blocks} and updated in database`);
        }
    } catch (err) {
        console.error(err);
    } finally {
        // always close db connection
        db.close();
        console.log("Done");
    }
})();
