const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const vision = require('@google-cloud/vision');
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

// Google Cloud setup
const serviceKey = path.join(__dirname, 'service-account-file.json');
const client = new vision.ImageAnnotatorClient({
    keyFilename: serviceKey,
});

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(fileUpload());
app.use(express.static('uploads'));
app.use(express.json());

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

app.post('/upload', async (req, res) => {
    if (!req.files || !req.files.image) {
        return res.status(400).send('No files were uploaded.');
    }

    const image = req.files.image;
    const uploadPath = path.join(__dirname, 'uploads', image.name);

    image.mv(uploadPath, async (err) => {
        if (err) {
            return res.status(500).send(err);
        }

        try {
            const [result] = await client.textDetection(uploadPath);
            const detections = result.textAnnotations;
            const extractedText = detections[0] ? detections[0].description : '';

            // Assuming license number is the first 16-digit number found in the text
            const licenseNumberMatch = extractedText.match(/\b\d{16}\b/);
            const licenseNumber = licenseNumberMatch ? licenseNumberMatch[0] : 'Not Found';

            // Assuming expiry date is in the format 'EXPIRES DD MMM YYYY'
            const expiryDateMatch = extractedText.match(/EXPIRES \d{2} \w{3} \d{4}/);
            const expiryDate = expiryDateMatch ? expiryDateMatch[0] : 'Not Found';

            // Scrape the license data using the detected license number
            const licenseData = await scrapeSIALicenses(licenseNumber.replace(/\s+/g, ''));

            // Add watermark to image
            const imageWithWatermark = await Jimp.read(uploadPath);
            const watermark = await Jimp.read(Buffer.from('Virtulum Checks', 'utf-8'));
            watermark.resize(Jimp.AUTO, 50); // Resize watermark to fit the image
            imageWithWatermark.composite(watermark, imageWithWatermark.bitmap.width - watermark.bitmap.width - 10, imageWithWatermark.bitmap.height - watermark.bitmap.height - 10, {
                mode: Jimp.BLEND_SOURCE_OVER,
                opacitySource: 0.5,
                opacityDest: 1,
            });

            const watermarkedImagePath = uploadPath.replace(/(\.\w+)$/, '_watermarked$1');
            await imageWithWatermark.writeAsync(watermarkedImagePath);

            res.json({
                name: `${licenseData.firstName} ${licenseData.surname}`,
                licenseNumber: licenseNumber,
                expiryDate: expiryDate,
                status: licenseData.valid ? 'Valid' : 'Invalid',
                imagePath: path.basename(watermarkedImagePath),
            });
        } catch (error) {
            console.error('Error processing image or extracting data:', error);
            res.status(500).send('Error processing image or extracting data.');
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
