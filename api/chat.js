// Proxy tipis ke API OpenAI-compatible. Key dibaca dari environment variable
// (.env saat lokal, Environment Variables di dashboard Vercel saat deploy).
const crypto = require("crypto");
const MAXTOK = Number(process.env.AI_MAX_TOKENS ?? 1500); // 0 = tidak dikirim
const TOLAK =
  "Maaf, saya hanya membantu seputar alat olahraga sekolah, isi tabel Anda, dan cara memakai aplikasi ini.";
const BASE = `Kamu asisten aplikasi data alat olahraga sekolah. Jawab singkat dalam bahasa Indonesia.
LINGKUP: hanya (1) isi tabel pengguna, (2) pengelolaan alat olahraga (perawatan, penyimpanan, pengadaan), (3) cara memakai aplikasi (unggah, unduh, undo, mode). Untuk hal lain balas persis: "${TOLAK}"
Jika pengguna meminta MEMBUAT/MENGUBAH tabel, balas HANYA satu objek JSON tanpa teks lain dan tanpa tanda \`\`\`:
{"message":"ringkasan singkat yang dilakukan","ops":[ ... ]}
Op yang boleh:
{"op":"create_table","columns":["nama","jumlah"]}
{"op":"add_column","name":"lokasi","default":""}
{"op":"delete_column","name":"lokasi"}
{"op":"add_rows","rows":[{"nama":"Bola","jumlah":10}]}  (maks 40 baris per permintaan)
{"op":"update_rows","where":{"nama":"Bola"},"set":{"jumlah":8}}
{"op":"delete_rows","where":{"kondisi":"Rusak"}}
{"op":"average","from":["praktik","teori"],"to":"rata_rata"}
{"op":"rank","by":"rata_rata","to":"peringkat"}
"where" = kecocokan persis pada kolom (nilai boleh berupa daftar; boleh memakai "_id"). Jangan kosongkan "where". Pakai nama kolom persis seperti di tabel.
Jangan menghitung sendiri: untuk rata-rata/peringkat pakai op average/rank; untuk jumlah/min/maks pakai angka di RINGKASAN_HITUNG.
Untuk pertanyaan atau obrolan dalam lingkup, jawab biasa (bukan JSON). Jangan membuat tabel di luar lingkup.`;
const MODE = {
  barang:
    "MODE BARANG: tabel inventaris alat olahraga (mis. nama, kategori, jumlah, kondisi, lokasi). Data contoh boleh, bukan data pribadi.",
  penilaian:
    'MODE PENILAIAN: tabel nilai penjas. Nama siswa sudah diganti kode seperti Siswa-001; pakai kode itu persis, jangan menebak atau mengarang nama asli. Tabel baru diisi placeholder "Siswa 1", "Siswa 2", dst.',
};

const hits = new Map(),
  fails = new Map(); // batas laju sederhana per IP (best-effort di serverless)
const recent = (m, ip, w) =>
  (m.get(ip) || []).filter((t) => Date.now() - t < w);
const sama = (a, b) => {
  const h = (x) => crypto.createHash("sha256").update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};

module.exports = async (req, res) => {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Gunakan POST" });
  const ip =
    String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() || "ip";
  // Satu WiFi sekolah = satu IP, jadi batasnya longgar (60/menit untuk semua pengguna di IP itu)
  const h = [...recent(hits, ip, 60000), Date.now()];
  hits.set(ip, h);
  if (hits.size > 1000) hits.clear();
  if (h.length > 60)
    return res
      .status(429)
      .json({ error: "Terlalu banyak permintaan. Tunggu sebentar." });
  const f = recent(fails, ip, 600000);
  if (f.length >= 10)
    return res
      .status(429)
      .json({ error: "Terlalu banyak kode salah. Coba lagi 10 menit lagi." });

  const { AI_API_KEY, AI_API_URL, AI_MODEL, ACCESS_CODE, AI_REASONING_EFFORT } =
    process.env;
  if (!AI_API_KEY || !AI_API_URL || !AI_MODEL)
    return res.status(500).json({
      error:
        "Konfigurasi server belum lengkap (AI_API_KEY, AI_API_URL, AI_MODEL).",
    });
  if (!ACCESS_CODE)
    return res
      .status(500)
      .json({ error: "ACCESS_CODE belum diisi di server." });
  if (!sama(req.headers["x-access-code"] || "", ACCESS_CODE)) {
    fails.set(ip, [...f, Date.now()]);
    if (fails.size > 1000) fails.clear();
    return res.status(401).json({ error: "Kode akses salah." });
  }

  const { mode, context = "", messages = [] } = req.body || {};
  if (!MODE[mode]) return res.status(400).json({ error: "Mode tidak valid." });
  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: "Pesan kosong." });
  if (String(context).length > 20000)
    return res
      .status(413)
      .json({ error: "Tabel terlalu besar untuk dikirim ke AI." });

  const msgs = messages.slice(-4).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content).slice(0, m.role === "assistant" ? 1000 : 500),
  }));
  try {
    const r = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      //   body: JSON.stringify({
      //     model: AI_MODEL,
      //     ...(MAXTOK > 0 && { max_tokens: MAXTOK }),
      //     ...(AI_REASONING_EFFORT && { reasoning_effort: AI_REASONING_EFFORT }),
      //     messages: [{ role: 'system', content: BASE + '\n\n' + MODE[mode] + '\n\nTABEL_SAAT_INI:\n' + context }, ...msgs],
      //   }),
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content:
              BASE + "\n\n" + MODE[mode] + "\n\nTABEL_SAAT_INI:\n" + context,
          },
          ...msgs,
        ],
      }),
    });
    // const d = await r.json().catch(() => ({}));
    // const reply = d?.choices?.[0]?.message?.content;
    // if (!r.ok || !reply) {
    //   console.error("AI error, status", r.status); // detail tidak dicatat/dikirim ke browser
    //   return res
    //     .status(502)
    //     .json({
    //       error:
    //         "AI gagal merespons (kode " +
    //         r.status +
    //         "). Periksa konfigurasi penyedia.",
    //     });
    // }
    const d = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("AI ERROR:", r.status, JSON.stringify(d, null, 2));

      return res.status(502).json({
        error: `AI gagal merespons (kode ${r.status}).`,
        detail:
          d?.error?.message || d?.error || "Tidak ada detail dari provider.",
      });
    }

    const reply = d?.choices?.[0]?.message?.content;

    if (!reply) {
      console.error("AI EMPTY RESPONSE:", JSON.stringify(d, null, 2));

      return res.status(502).json({
        error: "AI tidak mengembalikan isi jawaban.",
      });
    }
    res.status(200).json({ reply });
  } catch (e) {
    res
      .status(502)
      .json({ error: "Gagal menghubungi AI. Coba lagi sebentar lagi." });
  }
};
