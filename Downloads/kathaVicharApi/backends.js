const express = require('express');
const multer = require('multer');
const Minio = require('minio');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

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

// MinIO Client Configuration
const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || '134.199.223.51',
    port: 9000,
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});

// Configure DigitalOcean Spaces client
const spacesEndpoint = new AWS.Endpoint('sfo3.digitaloceanspaces.com'); // Use the base endpoint
const s3 = new AWS.S3({
    endpoint: spacesEndpoint,
    accessKeyId: process.env.SPACES_KEY || 'DO00L4Y7KEUJUHXQH6JD',
    secretAccessKey: process.env.SPACES_SECRET || 'ZSaOKzElZ5y7tEtaW64/U+jE3AaWAts2ZTy4n/w8faw',
    s3ForcePathStyle: true // Force path-style URLs
});
const BUCKET_NAME_AUDIO = 'audios';
const BUCKET_NAME_IMAGES= 'images';

// Ensure the bucket exists
//async function ensureBucketsExist() {
    //try {
       // const buckets = [BUCKET_NAME_AUDIO, BUCKET_NAME_IMAGES];

      //  for (const bucket of buckets) {
      //      const exists = await minioClient.bucketExists(bucket);
      //      if (!exists) {
       //         await minioClient.makeBucket(bucket);
       //         console.log(`Bucket '${bucket}' created.`);
       //     }
      //  }
  //  } catch (error) {
   //     console.error('Error checking/creating buckets:', error);
   // }
//}


// Ensure buckets exist (optional — Spaces creates them in the dashboard)
async function ensureBucketsExist() {
    try {
        const buckets = [BUCKET_NAME_AUDIO, BUCKET_NAME_IMAGES];
        for (const bucket of buckets) {
            try {
                await s3.headBucket({ Bucket: bucket }).promise();
            } catch (err) {
                if (err.statusCode === 404) {
                    await s3.createBucket({ Bucket: bucket }).promise();
                    console.log(`Bucket '${bucket}' created.`);
                } else {
                    throw err;
                }
            }
        }
    } catch (error) {
        console.error('Error checking/creating buckets:', error);
    }
}

ensureBucketsExist();


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

// Utility to remove spaces and special characters
function sanitizeFileName(fileName) {
    return fileName.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
}

// Upload audio file to MinIO
//const upload = multer({ dest: 'uploads/' });
//app.post('/upload', upload.fields([{ name: 'audio_file', maxCount: 1 }, { name: 'image_file', maxCount: 1 }]), async (req, res) => {
  //  try {
    //    const { title, artist } = req.body;
      //  const audioFile = req.files['audio_file'] ? req.files['audio_file'][0] : null;
        //const imageFile = req.files['image_file'] ? req.files['image_file'][0] : null;

        //if (!title || !artist || !audioFile) {
          //  return res.status(400).json({ error: 'Title, artist, and audio file are required!' });
        //}

        //const sanitizedTitle = sanitizeFileName(title);
        //const sanitizedArtist = sanitizeFileName(artist);
        //const sanitizedAudioName = sanitizeFileName(audioFile.originalname);
        //const audioFileName = `audio/${sanitizedArtist}/${sanitizedTitle}-${Date.now()}-${sanitizedAudioName}`;

        //let imageUrl = null;

        // Upload audio file to MinIO
        //await minioClient.fPutObject(BUCKET_NAME_AUDIO, audioFileName, audioFile.path, { 'Content-Type': 'audio/mpeg' });

        //if (imageFile) {
          //  const sanitizedImageName = sanitizeFileName(imageFile.originalname);
            //const imageFileName = `images/${sanitizedArtist}/${sanitizedTitle}-${Date.now()}-${sanitizedImageName}`;
            //await minioClient.fPutObject(BUCKET_NAME_IMAGES, imageFileName, imageFile.path);
            //imageUrl = `http://${process.env.MINIO_ENDPOINT || '134.199.223.51'}:9000/${BUCKET_NAME_IMAGES}/${imageFileName}`;
        //}

        //const audioUrl = `http://${process.env.MINIO_ENDPOINT || '134.199.223.51'}:9000/${BUCKET_NAME_AUDIO}/${audioFileName}`;

        //res.json({
          //  message: 'Song uploaded successfully to MinIO!',
            //audio_url: audioUrl,
            //image_url: imageUrl
        //});
    //} catch (error) {
      //  console.error('Error uploading files to MinIO:', error);
        //res.status(500).json({ error: 'File upload failed on MinIO!' });
  //  }
//});


const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.fields([
    { name: 'audio_file', maxCount: 1 },
    { name: 'image_file', maxCount: 1 }
]), async (req, res) => {
    try {
        const { title, artist } = req.body;
        const audioFile = req.files['audio_file']?.[0];
        const imageFile = req.files['image_file']?.[0];

        if (!title || !artist || !audioFile) {
            return res.status(400).json({ error: 'Title, artist, and audio file are required!' });
        }

        const sanitizeFileName = (name) =>
            name.replace(/[^a-z0-9_\-\.]/gi, '_').toLowerCase();

        const sanitizedTitle = sanitizeFileName(title);
        const sanitizedArtist = sanitizeFileName(artist);
        const audioFileName = `audio/${sanitizedArtist}/${sanitizedTitle}-${Date.now()}-${sanitizeFileName(audioFile.originalname)}`;
        const imageFileName = imageFile
            ? `images/${sanitizedArtist}/${sanitizedTitle}-${Date.now()}-${sanitizeFileName(imageFile.originalname)}`
            : null;

        // Upload audio
        const audioUpload = await s3.upload({
            Bucket: BUCKET_NAME_AUDIO,
            Key: audioFileName,
            Body: fs.createReadStream(audioFile.path),
            ACL: 'public-read',
            ContentType: 'audio/mpeg'
        }).promise();

        let imageUrl = null;

        // Upload image
        if (imageFile) {
            const imageUpload = await s3.upload({
                Bucket: BUCKET_NAME_IMAGES,
                Key: imageFileName,
                Body: fs.createReadStream(imageFile.path),
                ACL: 'public-read'
            }).promise();
            imageUrl = imageUpload.Location;
        }

        res.json({
            message: 'Song uploaded successfully to DigitalOcean Spaces!',
            audio_url: audioUpload.Location,
            image_url: imageUrl
        });
    } catch (error) {
        console.error('Error uploading to DigitalOcean Spaces:', error);
        res.status(500).json({ error: error, details: error.message });
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


// API Endpoint to get version and force update info
app.get('/app-version', async (req, res) => {
    try {
        // Fetch the latest settings from Supabase
        const { data, error } = await supabase
            .from('settings') // Assuming your table is named 'settings'
            .select('version, force_upgrade')
            .single(); // Fetch a single record

        if (error) {
            return res.status(500).json({ error: 'Error fetching version information from Supabase' });
        }

        if (!data) {
            return res.status(404).json({ error: 'Version info not found' });
        }

        const { version, force_upgrade } = data;

        // Send version and force upgrade information
        res.status(200).json({
            version: version, // Current version from Supabase
            force_upgrade: force_upgrade // Boolean indicating if a force upgrade is needed
        });
    } catch (error) {
        console.error('Error fetching version and force upgrade info:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
