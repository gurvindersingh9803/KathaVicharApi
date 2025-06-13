const express = require('express');
const multer = require('multer');
const Minio = require('minio');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const semver = require('semver');

const AWS = require('aws-sdk');
const fs = require('fs');

const app = express();
const port = 3000;
const corsOptions = {
    origin: '*', // Allow all origins (default)
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(bodyParser.json()); // Middleware to parse JSON body

// Configure Digital Ocean Spaces
const spacesEndpoint = new AWS.Endpoint('sfo3.digitaloceanspaces.com');
const s3 = new AWS.S3({
    endpoint: spacesEndpoint,
    accessKeyId: 'DO00Y8NLU79DTLQFU2Q9',
    secretAccessKey: 'SizZ+1toETvqvIcXZUS3OLzlFq1kAga7qfpGDfyK1hY'
});

// Function to sanitize strings (remove spaces and special characters)
const sanitizeString = (filename) => {
    const parts = filename.split('.');
    
    if (parts.length < 2) return ''; // Invalid filename (no extension)

    const ext = parts.pop(); // get the extension
    const name = parts.join('.'); // rejoin name in case of multiple dots in name

    const sanitized = name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')  // replace non-alphanumeric with hyphen
        .replace(/-+/g, '-')         // collapse multiple hyphens
        .replace(/^-|-$/g, '');      // trim leading/trailing hyphens

    return `${sanitized}.${ext.toLowerCase()}`;
};


// Function to ensure buckets exist
async function ensureBucketsExist() {
    const bucketPrefix = 'katha-'; // Change to your unique prefix
    const buckets = [`${bucketPrefix}audios`, `${bucketPrefix}images`];

    for (const bucketName of buckets) {
        try {
            console.log(`Checking if bucket "${bucketName}" exists...`);
            await s3.headBucket({ Bucket: bucketName }).promise();
            console.log(`Bucket "${bucketName}" already exists`);
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 403) {
                try {
                    console.log(`Creating bucket "${bucketName}"...`);
                    await s3.createBucket({ Bucket: bucketName }).promise();
                    console.log(`Bucket "${bucketName}" created successfully`);
                    await s3.putBucketAcl({ Bucket: bucketName, ACL: 'public-read' }).promise();
                    console.log(`Bucket "${bucketName}" set to public-read`);
                } catch (createError) {
                    console.error(`Error creating bucket "${bucketName}":`, createError);
                    throw createError;
                }
            } else {
                console.error(`Unexpected error checking bucket "${bucketName}":`, error);
                throw error;
            }
        }
    }
    return buckets;
}

function sanitizeArtistName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')   // replace non-alphanumeric with hyphen
        .replace(/-+/g, '-')          // collapse multiple hyphens
        .replace(/^-|-$/g, '');       // trim leading/trailing hyphens
}

// Configure multer for audio and image uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10000000 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const audioTypes = /mp3|wav|ogg|m4a/;
        const imageTypes = /jpeg|jpg|png/;
        const extname = audioTypes.test(path.extname(file.originalname).toLowerCase()) ||
                       imageTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetypes = [
            'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg',
            'image/jpeg', 'image/png', 'audio/m4a',
        ];
        const mimetype = mimetypes.includes(file.mimetype);

        if (extname && mimetype) {
            return cb(null, true);
        }
        cb('Error: Only audio (mp3, wav, ogg) or images (jpg, png) allowed!');
    }
}).fields([
    { name: 'audio', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]);

// Function to check if an image exists in the artist's folder
async function checkExistingImage(bucket, artist) {
    const params = {
        Bucket: bucket,
        Prefix: `${artist}/`, // Check the artist's subfolder
    };
    try {
        const data = await s3.listObjectsV2(params).promise();
        const imageFiles = data.Contents.filter(obj => /\.(jpg|jpeg|png)$/i.test(obj.Key));
        console.log(`adfgsdfgdsfgr "${bucket}" in "${artist}":`);
        console.log(`Images found for "${artist}" in "${bucket}":`, imageFiles.map(f => f.Key));
        return imageFiles.length > 0;
    } catch (error) {
        console.error(`Error listing objects in "${bucket}/${artist}":`, error);
        return false; // Assume no image if listing fails
    }
}

// Upload route
let audioBucket, imageBucket;
app.post('/upload', (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ error: err });
        }

        // Check for required fields
        const artistName = req.body.artist;
        if (!artistName) {
            return res.status(400).json({ error: 'Artist name is required' });
        }
        if (!req.files || (!req.files.audio && !req.files.image)) {
            return res.status(400).json({ error: 'At least one file (audio or image) is required' });
        }

        const sanitizedArtist = sanitizeArtistName(artistName);
        const response = { artist: sanitizedArtist };

        try {
            // Check for existing image
            const imageExists = req.files.image ? await checkExistingImage(imageBucket, sanitizedArtist) : false;
            console.log(`Image exists for "${sanitizedArtist}": ${imageExists}`);

            // Upload audio if present
            if (req.files.audio) {
                const audioFile = req.files.audio[0];
                const audioKey = `${sanitizedArtist}/${Date.now()}_${sanitizeString(audioFile.originalname)}`;
                const audioParams = {
                    Bucket: audioBucket,
                    Key: audioKey,
                    Body: audioFile.buffer,
                    ACL: 'public-read',
                    ContentType: audioFile.mimetype
                };
                const audioData = await s3.upload(audioParams).promise();
                response.audioUrl = getCDNUrl(audioBucket, audioKey);
            }

            // Upload image if present and no image exists yet
            if (req.files.image) {
                if (imageExists) {
                    response.imageNote = 'Image upload skipped: only one image allowed per artist';
                } else {
                    const imageFile = req.files.image[0];
                    const imageKey = `${sanitizedArtist}/${Date.now()}_${sanitizeString(imageFile.originalname)}`;
                    const imageParams = {
                        Bucket: imageBucket,
                        Key: imageKey,
                        Body: imageFile.buffer,
                        ACL: 'public-read',
                        ContentType: imageFile.mimetype
                    };
                    const imageData = await s3.upload(imageParams).promise();
                    response.imageUrl = getCDNUrl(imageBucket, imageKey);
                }
            }

            res.json({
                message: 'Files processed successfully',
                ...response
            });
        } catch (error) {
            console.error('Upload error:', error);
            res.status(500).json({ error: error });
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server and ensure buckets exist
async function startServer() {
    try {
        const buckets = await ensureBucketsExist();
        audioBucket = buckets[0]; // e.g., 'gurvinder-audios'
        imageBucket = buckets[1]; // e.g., 'gurvinder-images'
        app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });
    } catch (error) {
        console.error('Failed to start server due to bucket setup error:', error);
        process.exit(1);
    }
}

function getCDNUrl(bucket, key) {
    return `https://${bucket}.sfo3.cdn.digitaloceanspaces.com/${key}`;
}

startServer();

// Initialize the Supabase client
const supabaseUrl = 'https://jjejmgefvqeyhyhxgvas.supabase.co'; // Replace with your Supabase URL
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpqZWptZ2VmdnFleWh5aHhndmFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDExOTM3MjMsImV4cCI6MjA1Njc2OTcyM30.nZT9ry8Zdqj5jCuyHSPP0lPJ66RRjETthPDjEvbeUwo'; // Replace with your Supabase public/anonymous key
const supabase = createClient(supabaseUrl, supabaseKey);

// Fetch artist from the database to check if they exist
async function fetchArtistByName(artistName) {
    try {
        const { data, error } = await supabase
            .from('artists')
            .select()
            .eq('name', artistName)
            .limit(1);

        if (error) {
            throw error;
        }

        return data.length > 0 ? data[0] : null;
    } catch (error) {
        console.error('Error fetching artist on suprabase', error);
        return null;
    }
}

// API Endpoint to add artist
app.post('/add-artist', async (req, res) => {
    const { name, imgurl } = req.body;

    if (!name || !imgurl) {
        return res.status(400).json({ error: 'Name and imgurl are required on suprabase!' });
    }

    const existingArtist = await fetchArtistByName(name);

    if (existingArtist) {
        return res.status(400).json({ message: 'Artist already exists on suprabase', artist: existingArtist });
    }

    try {
        const { data, error } = await supabase
            .from('artists')
            .insert({ name, imgurl })
            .select();

        if (error) {
            throw error;
        }

        return res.status(201).json({ message: 'Artist added successfully to suprabase', data });
    } catch (error) {
        console.error('Error adding artist:', error);
        return res.status(500).json({ error: 'Error adding artist to suprabase' });
    }
});

// API Endpoint to fetch all artists
app.get('/artists', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('artists')
            .select();

        if (error) {
            throw error;
        }

        return res.status(200).json({ artists: data });
    } catch (error) {
        return res.status(500).json({ error: 'Error fetching artists on suprabase' });
    }
});

// API Endpoint to fetch all artists
app.get('/songs/:artistId', async (req, res) => {
    const { artistId } = req.params;
    try {
        const { data, error } = await supabase
            .from('songs')
            .select('*')
            .eq('artist_id', artistId)

        if (error) {
            throw error;
        }

        return res.status(200).json({ songs: data });
    } catch (error) {
        return res.status(500).json({ error: 'Error fetching artists on suprabase' });
    }
});


// Add song endpoint (with relationship to artist)
app.post('/add-song', async (req, res) => {
    const { title, audiourl, imgurl, artistId } = req.body;
    if (!title || !audiourl || !imgurl || !artistId) {
        return res.status(400).json({ error: 'Title, audioUrl, imgUrl, and artistId are required in suprabase' });
    }

    const { data: artistData, error: artistError } = await supabase
        .from('artists')
        .select()
        .eq('id', artistId)
        .limit(1);

    if (artistError || artistData.length === 0) {
        return res.status(400).json({ error: 'Artist not found in suprabase' });
    }

    try {
        const { data, error } = await supabase
            .from('songs')
            .insert([{ title, audiourl, imgurl, artist_id: artistId }])
            .select();

        if (error) {
            throw error;
        }

        return res.status(201).json({ message: 'Song added successfully to suprabase', data });
    } catch (error) {
        console.error('Error adding song:', error);
        return res.status(500).json({ error: 'Error adding song to suprabase' });
    }
});


// Assuming you are using Express.js for your server
// API Endpoint to Get Artist Image URL
app.get('/artist-image/:artistName', async (req, res) => {
    try {
        const { artistName } = req.params;

        // Fetch artist's image URL from Supabase
        const { data, error } = await supabase
            .from('artists')
            .select('imgurl') // Select only the image URL
            .eq('name', artistName)
            .limit(1)
            .single(); // Fetch a single record directly

        if (error) {
            return res.status(500).json({ error: 'Error fetching artist image from Supabase' });
        }

        if (!data) {
            return res.status(404).json({ error: 'Artist not found' });
        }

        res.json({ imageUrl: data.imgurl });
    } catch (error) {
        console.error('Error fetching artist image:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/app-version', async (req, res) => {
    const currentVersion = String(req.query.currentVersion); 

  if (!currentVersion) {
    return res.status(400).json({ error: "Missing 'currentVersion' in request body" });
  }

  try {
    // Fetch all versions from the app_versions table
    const { data: versions, error } = await supabase
      .from("version_setting")
      .select("*");

    if (error) throw error;

    if (!versions || versions.length === 0) {
      return res.status(404).json({ error: "No version data found in the database." });
    }

    // Sort versions descending using semver
    const sortedVersions = versions.sort((a, b) => semver.rcompare(a.version, b.version));
    const latest = sortedVersions[0];

    const needsUpgrade = semver.lt(currentVersion, latest.version);

    const forceEntry = versions.find(v => v.version === currentVersion && v.force_upgrade === true);
    const forceUpgrade = !!forceEntry;

    return res.status(200).json({
      latestVersion: latest.version,
      needsUpgrade,
      forceUpgrade,
      releaseNotes: latest.release_notes || "",
    });

  } catch (err) {
    console.error("Version check failed:", err);
    return res.status(500).json({ error: "Version check failed", details: err.message });
  }
});

app.get('/app-version_not_using', async (req, res) => {
    try {
        // Hardcode the UUID
        const uuid = '654880e6-7d85-4d18-9c1e-73f80a7dfd10';

        // Fetch the settings row using the hardcoded UUID
        const { data, error } = await supabase
            .from('version_setting')
            .select("*")
            .order("version", { ascending: false })
            .limit(1)
            .single();

        console.log('Supabase Response:', { data, error });

        if (error) {
            console.error('Supabase Error:', error);
            return res.status(500).json({ error: 'Error fetching version information from Supabase' });
        }

        if (!data) {
            console.error('Missing required fields in data:', data);
            return res.status(404).json({ error: 'Version info not found or invalid in the database' });
        }

        // Return the version and force_upgrade data
        res.status(200).json({
            data: data,
        });
    } catch (error) {
        console.error('Unexpected Error:', error);
        res.status(500).json({ error: error.message || error });
    }
});


