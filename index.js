import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

const app = express();
app.use(express.json());

// Inisialisasi Supabase dengan validasi
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: SUPABASE_URL dan SUPABASE_KEY harus diset di file .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Validasi URL
 */
const isValidUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Logika pembuatan Short Code
 * Mendukung karakter: a-z, 0-9, titik (.), dash (-), underscore (_)
 */
const generateShortCode = (customCode = null, length = 6) => {
  if (customCode && customCode.trim() !== "") {
    const trimmed = customCode.trim();
    
    // Validasi: hanya alfanumerik, titik, dash, dan underscore
    const validPattern = /^[a-zA-Z0-9._-]+$/;
    if (!validPattern.test(trimmed)) {
      throw new Error('Custom code hanya boleh mengandung huruf, angka, titik (.), dash (-), atau underscore (_)');
    }
    
    // Konversi ke lowercase
    const sanitized = trimmed.toLowerCase();
    
    // Validasi panjang minimal
    if (sanitized.length < 3) {
      throw new Error('Custom code minimal 3 karakter');
    }
    
    // Validasi maksimal
    if (sanitized.length > 50) {
      throw new Error('Custom code maksimal 50 karakter');
    }
    
    // Validasi tidak boleh dimulai atau diakhiri dengan karakter spesial
    if (/^[._-]|[._-]$/.test(sanitized)) {
      throw new Error('Custom code tidak boleh dimulai atau diakhiri dengan titik, dash, atau underscore');
    }
    
    // Validasi tidak boleh ada karakter spesial berturut-turut
    if (/[._-]{2,}/.test(sanitized)) {
      throw new Error('Tidak boleh ada titik, dash, atau underscore berturut-turut');
    }
    
    return sanitized;
  }

  // Generate random code (hanya alfanumerik)
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
};

/**
 * CRON JOB: Pembersihan Otomatis
 * Berjalan setiap hari jam 00:00 untuk menghapus data tidak aktif > 365 hari.
 */
cron.schedule('0 0 * * *', async () => {
  console.log('--- Menjalankan Pembersihan URL Otomatis ---');
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 365);

  try {
    const { data, error } = await supabase
      .from('urls')
      .delete()
      .lt('last_clicked_at', cutoffDate.toISOString())
      .select();

    if (error) throw error;
    console.log(`✅ Berhasil membersihkan ${data?.length || 0} URL yang sudah tidak aktif.`);
  } catch (err) {
    console.error('❌ Gagal menjalankan Cron Job:', err.message);
  }
});

/**
 * Endpoint POST: Memperpendek URL
 */
app.post('/shorten', async (req, res) => {
  const { originalUrl, customName } = req.body;
  const domain = process.env.DOMAIN;

  // Validasi input
  if (!originalUrl) {
    return res.status(400).json({ 
      success: false, 
      message: "URL asal wajib diisi." 
    });
  }

  if (!isValidUrl(originalUrl)) {
    return res.status(400).json({ 
      success: false, 
      message: "URL tidak valid. Harus dimulai dengan http:// atau https://" 
    });
  }

  try {
    let shortCode;

    // Jika ada custom name
    if (customName) {
      try {
        shortCode = generateShortCode(customName);
      } catch (error) {
        return res.status(400).json({ 
          success: false, 
          message: error.message 
        });
      }

      // Cek apakah sudah ada
      const { data: existing } = await supabase
        .from('urls')
        .select('short_code')
        .eq('short_code', shortCode)
        .maybeSingle();

      if (existing) {
        return res.status(400).json({ 
          success: false, 
          message: "Custom URL sudah digunakan. Silakan pilih nama lain." 
        });
      }
    } else {
      // Generate random code dengan max retry
      let isUnique = false;
      let attempts = 0;
      const maxAttempts = 10;

      while (!isUnique && attempts < maxAttempts) {
        shortCode = generateShortCode(null, 6);
        const { data } = await supabase
          .from('urls')
          .select('short_code')
          .eq('short_code', shortCode)
          .maybeSingle();
        
        if (!data) {
          isUnique = true;
        }
        attempts++;
      }

      if (!isUnique) {
        return res.status(500).json({ 
          success: false, 
          message: "Gagal generate kode unik. Silakan coba lagi." 
        });
      }
    }

    // Insert ke database
    const { error } = await supabase.from('urls').insert([{ 
      original_url: originalUrl, 
      short_code: shortCode,
      created_at: new Date().toISOString(),
      last_clicked_at: new Date().toISOString()
    }]);

    if (error) throw error;

    res.status(201).json({ 
      success: true, 
      shortUrl: `${domain}${shortCode}`,
      shortCode: shortCode
    });
  } catch (err) {
    console.error('Error saat shorten URL:', err);
    res.status(500).json({ 
      success: false, 
      message: "Terjadi kesalahan server. Silakan coba lagi." 
    });
  }
});

/**
 * Endpoint GET: Redirect & Update Waktu Klik Terakhir
 */
app.get('/:code', async (req, res) => {
  const { code } = req.params;

  // Validasi format code - sekarang support ._-
  if (!/^[a-z0-9._-]+$/i.test(code)) {
    return res.status(400).send("Format short code tidak valid.");
  }

  try {
    const { data, error } = await supabase
      .from('urls')
      .select('original_url')
      .eq('short_code', code.toLowerCase()) // Pastikan case-insensitive
      .maybeSingle();

    if (error) throw error;

    if (data) {
      // Update last_clicked_at secara async (non-blocking)
      supabase
        .from('urls')
        .update({ last_clicked_at: new Date().toISOString() })
        .eq('short_code', code.toLowerCase())
        .then()
        .catch(err => console.error('Error update last_clicked_at:', err));

      return res.redirect(301, data.original_url);
    }

  //  res.status(404).send("Short URL tidak ditemukan.");
    res.status(404).send(`
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 - Link Tidak Ditemukan</title>
    <style>
        body {
            font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background-color: #f8f9fa;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            color: #333;
            text-align: center;
        }
        h1 {
            font-size: 120px;
            margin: 0;
            color: #ff4757;
            line-height: 1;
        }
        h2 {
            font-size: 24px;
            margin: 10px 0;
            color: #2f3542;
        }
        p {
            font-size: 16px;
            color: #747d8c;
            max-width: 300px;
            margin: 0 auto;
        }
    </style>
</head>
<body>
    <div>
        <h1>404</h1>
        <h2>Oops! Link Hilang</h2>
        <p>Maaf, Short URL yang kamu cari tidak terdaftar atau sudah kedaluwarsa.</p>
    </div>
</body>
</html>
`);
    
  } catch (err) {
    console.error('Error saat redirect:', err);
    res.status(500).send("Terjadi kesalahan server.");
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

/**
 * 404 Handler
 */
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint tidak ditemukan.' 
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server aktif di port ${PORT}`);
  console.log(`📅 Cron job pembersihan URL terjadwal setiap hari jam 00:00`);
});
export default app;
