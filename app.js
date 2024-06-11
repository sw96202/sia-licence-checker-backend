const express = require('express');
const fileUpload = require('express-fileupload');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(fileUpload());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Google Cloud setup
const serviceKey = path.join(__dirname, 'service-account-file.json');
const storage = new Storage({ keyFilename: serviceKey });
const bucketName = 'sia9620'; // Update with your bucket name

// Function to upload file to Google Cloud Storage
async function uploadToStorage(file) {
  const bucket = storage.bucket(bucketName);
  const blob = bucket.file(file.name);
  const blobStream = blob.createWriteStream({
    resumable: false,
  });

  return new Promise((resolve, reject) => {
    blobStream
      .on('finish', () => {
        resolve(`https://storage.googleapis.com/${bucketName}/${file.name}`);
      })
      .on('error', (err) => {
        reject(err);
      })
      .end(file.data);
  });
}

// Function to extract text using Google Cloud Vision
async function extractTextFromImage(imageUrl) {
  const client = new vision.ImageAnnotatorClient({ keyFilename: serviceKey });
  const [result] = await client.textDetection(imageUrl);
  return result.fullTextAnnotation ? result.fullTextAnnotation.text : '';
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

// Upload endpoint
app.post('/upload', async (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).send('No files were uploaded.');
  }

  const file = req.files.file;

  try {
    const imageUrl = await uploadToStorage(file);
    const extractedText = await extractTextFromImage(imageUrl);

    const licenseNo = extractedText.match(/\d{4}\s\d{4}\s\d{4}\s\d{4}/);
    if (!licenseNo) {
      return res.status(200).send({
        name: 'Not Found',
        licenceNumber: 'Not Found',
        expiryDate: 'Not Found',
        isValidLicence: false,
      });
    }

    const licenseInfo = await scrapeSIALicenses(licenseNo[0].replace(/\s/g, ''));
    res.status(200).send({
      name: `${licenseInfo.firstName} ${licenseInfo.surname}`,
      licenceNumber: licenseInfo.licenseNumber,
      expiryDate: licenseInfo.expiryDate,
      isValidLicence: licenseInfo.status === 'Active',
    });
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Error processing request');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
