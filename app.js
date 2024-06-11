const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision');
const axios = require('axios');
const retry = require('async-retry');

const app = express();
const port = process.env.PORT || 10000;

// Middleware setup
app.use(express.json());
app.use(cors());
app.use(fileUpload());

// Google Cloud setup
const serviceKey = path.join(__dirname, 'service-account-file.json');
const storage = new Storage({ keyFilename: serviceKey });
const client = new vision.ImageAnnotatorClient({ keyFilename: serviceKey });

const bucketName = 'your-bucket-name';

app.post('/upload', async (req, res) => {
    try {
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).send('No files were uploaded.');
        }

        const file = req.files.file;
        const filePath = path.join(__dirname, 'uploads', file.name);

        await file.mv(filePath);

        // Upload to Google Cloud Storage
        await storage.bucket(bucketName).upload(filePath);

        const [result] = await client.textDetection(filePath);
        const detections = result.textAnnotations;

        let licenceNumber = '';
        let expiryDate = '';
        let name = '';

        detections.forEach(text => {
            if (text.description.match(/^\d{4}\s\d{4}\s\d{4}\s\d{4}$/)) {
                licenceNumber = text.description.replace(/\s/g, '');
            } else if (text.description.includes('EXPIRES')) {
                expiryDate = text.description.replace('EXPIRES', '').trim();
            } else if (text.description.includes('ANDREW')) {
                name = text.description;
            }
        });

        const response = await retry(async () => {
            return await axios.post('https://services.sia.homeoffice.gov.uk/PublicRegister/SearchPublicRegisterByLicence', {
                licenseNo: licenceNumber
            });
        }, {
            retries: 3
        });

        const $ = cheerio.load(response.data);

        const firstName = $('.ax_paragraph').eq(0).next().find('.ax_h5').text().trim();
        const surname = $('.ax_paragraph').eq(1).next().find('.ax_h5').text().trim();
        const licenseNumber = $('.ax_paragraph').eq(2).next().find('.ax_h4').text().trim();
        const role = $('.ax_paragraph').eq(3).next().find('.ax_h4').text().trim();
        const expiryDate = $('.ax_paragraph:contains("Expiry date")').next().find('.ax_h4').text().trim();
        const status = $('.ax_paragraph:contains("Status")').next().find('.ax_h4_green').text().trim();

        if (!firstName || !surname || !licenseNumber || !role || !expiryDate || !status) {
            return { valid: false };
        }

        return {
            valid: true,
            firstName,
            surname,
            licenseNumber,
            role,
            expiryDate,
            status
        };

        res.json({
            licenceNumber,
            expiryDate,
            name,
            isValidLicence: response.data.valid
        });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).send('Error checking SIA license: ' + error.message);
    }
});

app.listen(port, () => {
    console.log(`Server started on port ${port}`);
});
