const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision');
const Jimp = require('jimp');

const app = express();
const PORT = process.env.PORT || 10000;

const serviceKey = path.join(__dirname, 'service-account-file.json');
const storage = new Storage({ keyFilename: serviceKey });
const client = new vision.ImageAnnotatorClient({ keyFilename: serviceKey });

app.use(cors());
app.use(fileUpload());
app.use(express.json());
app.use(express.static('uploads'));

async function extractTextFromImage(filePath) {
  try {
    const [result] = await client.textDetection(filePath);
    const detections = result.textAnnotations;
    return detections[0] ? detections[0].description : 'No text found';
  } catch (error) {
    console.error('Error detecting text:', error);
    throw new Error('Error detecting text from image');
  }
}

async function scrapeSIALicenses(licenseNo) {
  try {
    const response = await axios.post(
      'https://services.sia.homeoffice.gov.uk/PublicRegister/SearchPublicRegisterByLicence',
      { licenseNo }
    );

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

app.post('/upload', async (req, res) => {
  if (!req.files || !req.files.image) {
    return res.status(400).send('No image uploaded');
  }

  const image = req.files.image;
  const uploadPath = path.join(__dirname, 'uploads', image.name);

  image.mv(uploadPath, async (err) => {
    if (err) {
      console.error('Error uploading image:', err);
      return res.status(500).send('Error uploading image');
    }

    try {
      const text = await extractTextFromImage(uploadPath);

      const licenseNoMatch = text.match(/\b\d{4}\s\d{4}\s\d{4}\s\d{4}\b/);
      const licenseNo = licenseNoMatch ? licenseNoMatch[0].replace(/\s/g, '') : null;
      const expiryDateMatch = text.match(/EXPIRES\s\d{2}\s\w{3}\s\d{4}/);
      const expiryDate = expiryDateMatch ? expiryDateMatch[0] : 'Not Found';
      const nameMatch = text.match(/(?:EXPIRES\s\d{2}\s\w{3}\s\d{4})\s+([\s\S]+)/);
      const name = nameMatch ? nameMatch[1].trim().split('\n')[0] : 'Not Found';

      if (!licenseNo) {
        return res.json({
          licenseNumber: 'Not Found',
          expiryDate: expiryDate || 'Not Found',
          name: name || 'Not Found',
          isValidLicence: false,
          error: 'License number not found in image'
        });
      }

      const licenseData = await scrapeSIALicenses(licenseNo);

      res.json({
        licenseNumber: licenseNo || 'Not Found',
        expiryDate: expiryDate || 'Not Found',
        name: licenseData.valid ? `${licenseData.firstName} ${licenseData.surname}` : 'Not Found',
        isValidLicence: licenseData.valid,
        error: licenseData.valid ? null : 'Invalid license data'
      });
    } catch (error) {
      console.error('Error processing image:', error);
      res.status(500).send('Failed to process image or license data');
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
