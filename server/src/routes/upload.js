const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const fs = require('fs');

const router = express.Router();

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('이미지 파일만 업로드 가능합니다. (JPG, PNG, WEBP)'));
    }
  },
});

// POST /api/upload
router.post('/', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '이미지 파일을 첨부해주세요.' });
  }

  // Resize if too large (max 1920px wide)
  const resizedFilename = `resized_${req.file.filename}`;
  const resizedPath = path.join(uploadDir, resizedFilename);

  await sharp(req.file.path)
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toFile(resizedPath);

  // Remove original
  fs.unlinkSync(req.file.path);

  const imageId = path.basename(resizedFilename, path.extname(resizedFilename));
  const imageUrl = `/uploads/${resizedFilename}`;

  res.json({
    imageId,
    imageUrl,
    filename: req.file.originalname,
  });
});

module.exports = router;
