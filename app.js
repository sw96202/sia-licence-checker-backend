const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const vision = require('@google-cloud/vision');
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(fileUpload());
app.use(express.json());
app.use(express.static('public'));

// Google Cloud setup
const serviceKey = path.join(__dirname, 'service-account-file.json');
const client = new vision.ImageAnnotatorClient({ keyFilename: serviceKey });
const storage = new Storage({ keyFilename: serviceKey });
const bucketName = process.env.GCLOUD_STORAGE_BUCKET;

// Function to upload image to Google Cloud Storage
async function uploadToStorage(file) {
  const bucket = storage.bucket(bucketName);
  const blob = bucket.file(file.name);
  const blobStream = blob.createWriteStream({
    resumable: false,
  });

  return new Promise((resolve, reject) => {
    blobStream.on('finish', () => {
      resolve(`https://storage.googleapis.com/${bucketName}/${blob.name}`);
    }).on('error', (err) => {
      reject(err);
    }).end(file.data);
  });
}

// Function to scrape SIA license data
async function scrapeSIALicenses(licenseNo) {
  try {
    const response = await axios.post('https://services.sia.homeoffice.gov.uk/PublicRegister/SearchPublicRegisterByLicence', {
      licenseNo: licenseNo
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
  } catch (error) {
    console.error('Error scraping SIA website:', error);
    return { valid: false };
  }
}

// Function to extract text from image using Google Cloud Vision API
async function extractTextFromImage(imageUrl) {
  const [result] = await client.textDetection(imageUrl);
  const detections = result.textAnnotations;
  if (detections.length > 0) {
    return detections[0].description;
  }
  return '';
}

// Endpoint to handle image upload and text extraction
app.post('/upload', async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send('No file uploaded.');
  }

  const file = req.files.file;

  try {
    const imageUrl = await uploadToStorage(file);
    const extractedText = await extractTextFromImage(imageUrl);

    const licenceNumberRegex = /\b\d{4}\s\d{4}\s\d{4}\s\d{4}\b/;
    const match = extractedText.match(licenceNumberRegex);

    if (!match) {
      return res.status(200).json({ name: 'Not Found', licenceNumber: 'Not Found', expiryDate: 'Not Found', isValidLicence: false });
    }

    const licenceNumber = match[0].replace(/\s/g, '');

    const licenceData = await scrapeSIALicenses(licenceNumber);

    if (licenceData.valid) {
      return res.status(200).json({
        name: `${licenceData.firstName} ${licenceData.surname}`,
        licenceNumber: licenceData.licenseNumber,
        expiryDate: licenceData.expiryDate,
        isValidLicence: licenceData.status.toLowerCase() === 'active'
      });
    } else {
      return res.status(200).json({ name: 'Not Found', licenceNumber: 'Not Found', expiryDate: 'Not Found', isValidLicence: false });
    }
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).send('Failed to upload image or process license data.');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
