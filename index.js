import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import pg from "pg";

console.log("APP_VERSION: 2025-12-23-update-meta-v1");
console.log("DB_URL set:", Boolean(process.env.DATABASE_URL));
console.log("DB_URL prefix:", (process.env.DATABASE_URL || "").slice(0, 12)); // должно быть "postgresql:/"


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



const app = express();
// ---- Global error handlers ----
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// ====== CONFIG ======
const API_URL = "https://covers.openlibrary.org/b"; // base
const coverUrl = (isbn, size = "L") =>
  isbn ? `${API_URL}/isbn/${isbn}-${size}.jpg?default=false` : null;

const amazonLink = (isbn, title, author) => {
  if (isbn && String(isbn).trim()) {
    return `https://www.amazon.com/s?k=${encodeURIComponent(String(isbn).trim())}`;
  }
  const q = [title, author].filter(Boolean).join(" ");
  return `https://www.amazon.com/s?k=${encodeURIComponent(q)}`;
};

// ====== DB (Render) ======
// Important: no localhost and passwords in a code.
// Render provides DATABASE_URL. SSL necessary on a  free-plan.
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
// Debug info
console.log("DB_URL set:", Boolean(process.env.DATABASE_URL));
db.query("SELECT 1")
  .then(() => console.log("DB OK ✅"))
  .catch((e) => console.error("DB FAIL ❌", e));

// ====== MIDDLEWARE ======
app.use(express.urlencoded({ extended: true })); // instead of body-parser
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // give away /public

// Включаем EJS-шаблоны из папки /views
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// ====== ROUTES ======
app.get("/", async (req, res) => {
  const sort = (req.query.sort || "best").toLowerCase();
  const order = (req.query.order || (sort === "title" ? "asc" : "desc")).toUpperCase();

  const sortSql =
    {
      best: `rating ${order} NULLS LAST, read_date DESC NULLS LAST, lower(books_name) ASC`,
      newest: `read_date ${order} NULLS LAST, rating DESC NULLS LAST, lower(books_name) ASC`,
      title: `lower(books_name) ${order}, read_date DESC NULLS LAST`,
    }[sort] || `rating DESC NULLS LAST, read_date DESC NULLS LAST`;

  const { rows: books } = await db.query(
    `SELECT id, books_name, author, isbn, read_date, rating
     FROM lib_books
     ORDER BY ${sortSql}`
  );

  const withCovers = books.map((b) => ({
    ...b,
    cover: coverUrl(b.isbn) || "/placeholder.png",
    buyUrl: amazonLink(b.isbn, b.books_name, b.author),
  }));

  // В EJS you don't need to wright .ejs in the name of the file
  res.render("index", {
    title: "My Read Books",
    books: withCovers,
    sort,
    order,
  });
});
// edit form
app.get("/books/:id/edit", async (req, res) => {
  const { id } = req.params;
  const { rows } = await db.query("SELECT * FROM lib_books WHERE id=$1", [id]);
  if (!rows[0]) return res.status(404).send("Not found");
  const book = rows[0];
  res.render("edit", { title: "Edit book", book });
});

app.get("/books/:id", async (req, res) => {
  const { id } = req.params;
  const { rows } = await db.query("SELECT * FROM lib_books WHERE id=$1", [id]);
  if (!rows[0]) return res.status(404).send("Not found");
  const book = rows[0];
  book.cover = coverUrl(book.isbn) || "/placeholder.png";
  book.buyUrl = amazonLink(book.isbn, book.books_name, book.author);
  res.render("book", { title: "Book details", book });
});

// form
app.get("/new", (req, res) => res.render("new", { title: "Add a book" }));

// create
// helper functions
const toNull = v => (v === '' || v === undefined || v === null ? null : v);
const toIntOrNull = v => {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// add book
app.post("/books", async (req, res) => {
  try {
    const { books_name, author, isbn, read_date, rating, notes } = req.body;

    if (!books_name?.trim()) {
      return res.status(400).send("Title is required");
    }

    const r = toIntOrNull(rating);
    if (r !== null && (r < 0 || r > 10)) {
      return res.status(400).send("Rating must be between 0 and 10");
    }

    const sql = `
      INSERT INTO lib_books (books_name, author, isbn, read_date, rating, notes)
      VALUES (
        $1,
        NULLIF($2,''),
        NULLIF($3,''),
        NULLIF($4,'')::timestamp,
        $5,
        NULLIF($6,'')
      )
    `;
    const params = [
      books_name.trim(),
      toNull(author),
      toNull(isbn),
      toNull(read_date),
      r,
      toNull(notes)
    ];

    await db.query(sql, params);
    res.redirect("/");
  } catch (err) {
    console.error("POST /books failed:", err.message, err.detail);
    res.status(500).send("Server error while adding a book");
  }
});

// update meta
app.post("/books/:id/update-notes", async (req, res) => {
  try {
    const { id } = req.params;
    const { books_name, author, isbn, read_date, rating } = req.body;

    if (!books_name?.trim()) {
      return res.status(400).send("Title is required");
    }

    const r = toIntOrNull(rating);
    if (r !== null && (r < 0 || r > 10)) {
      return res.status(400).send("Rating must be between 0 and 10");
    }

    await db.query(
      `UPDATE lib_books
       SET books_name = $1,
           author = NULLIF($2,''),
           isbn = NULLIF($3,''),
           read_date = NULLIF($4,'')::timestamp,
           rating = $5
       WHERE id = $6`,
      [books_name.trim(), author || "", isbn || "", read_date || "", r, id]
    );

    res.redirect(`/books/${id}`);
  } catch (err) {
    console.error("POST /books/:id/update-meta failed:", err);
    res.status(500).send("Server error while updating a book");
  }
});
// delete
app.post("/books/:id/delete", async (req, res) => {
  const { id } = req.params;
  await db.query("DELETE FROM lib_books WHERE id=$1", [id]);
  res.redirect("/");
});

// REST API
app.get("/api/books", async (req, res) => {
  const { rows } = await db.query("SELECT * FROM lib_books ORDER BY id DESC");
  res.json(rows);
});

app.get("/api/books/:id", async (req, res) => {
  const { rows } = await db.query("SELECT * FROM lib_books WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

app.post("/api/books", async (req, res) => {
  const { books_name, author, isbn, notes, read_date, rating } = req.body;
  const { rows } = await db.query(
    `INSERT INTO lib_books (books_name, author, isbn, notes, read_date, rating)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [books_name, author, isbn || null, notes || null, read_date || null, rating || null]
  );
  res.status(201).json(rows[0]);
});

app.get("/debug", (req, res) => {
  res.json({ ok: true, version: "2025-12-23-update-meta-v1" });
});
// Healthcheck (helpfull for Render)
app.get("/health", (req, res) => res.send("ok"));

// ====== START ======
const PORT = process.env.PORT || 3000;
// on the Render have to listen to 0.0.0.0


app.get("/debug", (req, res) => {
  res.json({
    ok: true,
    hasUpdateMetaRouteExpected: true,
    time: new Date().toISOString(),
  });
});
app.listen(PORT, "0.0.0.0", () => console.log(`BookNotes on ${PORT}`));
