const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const vision = require('@google-cloud/vision');
const Jimp = require('jimp');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

// Initialize the app
const app = express();
const port = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// Google Cloud setup
const serviceKey = path.join(__dirname, 'service-account-file.json');
const client = new vision.ImageAnnotatorClient({
  keyFilename: serviceKey,
});

// Function to extract text using Google Cloud Vision
async function extractText(filePath) {
  const [result] = await client.textDetection(filePath);
  const detections = result.textAnnotations;
  return detections.length ? detections[0].description : 'No text found';
}

// Function to scrape SIA license data
async function scrapeSIALicenses(licenseNo) {
  try {
    const response = await axios.post('https://services.sia.homeoffice.gov.uk/PublicRegister/SearchPublicRegisterByLicence', {
      licenseNo: licenseNo,
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
      status,
    };
  } catch (error) {
    console.error('Error scraping SIA website:', error);
    return { valid: false };
  }
}

// Route to handle file upload
app.post('/upload', async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send('No file uploaded.');
  }

  const file = req.files.file;
  const filePath = path.join(__dirname, 'uploads', file.name);

  file.mv(filePath, async (err) => {
    if (err) {
      return res.status(500).send(err);
    }

    try {
      const text = await extractText(filePath);
      const licenseNumber = text.match(/\b\d{4} \d{4} \d{4} \d{4}\b/)[0].replace(/\s/g, '');
      const siaData = await scrapeSIALicenses(licenseNumber);

      if (siaData.valid) {
        res.json({
          name: `${siaData.firstName} ${siaData.surname}`,
          licenseNumber: siaData.licenseNumber,
          expiryDate: siaData.expiryDate,
          isValidLicence: siaData.status === 'Active',
        });
      } else {
        res.json({
          name: 'Not Found',
          licenseNumber: 'Not Found',
          expiryDate: 'Not Found',
          isValidLicence: false,
        });
      }
    } catch (error) {
      console.error('Error processing file:', error);
      res.status(500).send('Error processing file.');
    }
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
