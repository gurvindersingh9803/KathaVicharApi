const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const path = require('path');

const app = express();
const port = 3001;

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

// Configure multer for audio and image uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10000000 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const audioTypes = /mp3|wav|ogg/;
        const imageTypes = /jpeg|jpg|png/;
        const extname = audioTypes.test(path.extname(file.originalname).toLowerCase()) ||
                       imageTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetypes = [
            'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg',
            'image/jpeg', 'image/png'
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

        const sanitizedArtist = artistName;
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
