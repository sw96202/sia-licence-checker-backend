const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const cheerio = require('cheerio');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const serviceKey = path.join(__dirname, 'service-account-file.json');
const visionClient = new ImageAnnotatorClient({
  keyFilename: serviceKey,
});

const storage = multer.memoryStorage();
const upload = multer({ storage });

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

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const [result] = await visionClient.textDetection(req.file.buffer);
    const detections = result.textAnnotations;
    const text = detections.length ? detections[0].description : '';

    const licenseNumberMatch = text.match(/\b\d{16}\b/);
    const expiryDateMatch = text.match(/\b\d{2} \w{3} \d{4}\b/);
    const nameMatch = text.match(/(?:[A-Z]\.)+\s+[A-Z][a-z]+/);

    const licenseNumber = licenseNumberMatch ? licenseNumberMatch[0] : 'Not Found';
    const expiryDate = expiryDateMatch ? expiryDateMatch[0] : 'Not Found';
    const name = nameMatch ? nameMatch[0] : 'Not Found';

    const scrapedData = await scrapeSIALicenses(licenseNumber.replace(/\s+/g, ''));

    const image = await Jimp.read(req.file.buffer);
    image.print(Jimp.FONT_SANS_32_BLACK, 10, 10, 'Virtulum Checks');
    const imageName = `uploads/${Date.now()}_${req.file.originalname}`;
    await image.writeAsync(imageName);

    res.json({
      licenseNumber,
      expiryDate,
      name: scrapedData.valid ? `${scrapedData.firstName} ${scrapedData.surname}` : 'Not Found',
      status: scrapedData.valid ? 'Valid' : 'Invalid',
      imagePath: imageName
    });
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).json({ error: 'Error processing image' });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
