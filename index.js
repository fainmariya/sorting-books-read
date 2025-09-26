import express from "express";
import bodyParser from "body-parser";
import path from 'path';
import axios from "axios";
import pg from "pg";
import { fileURLToPath } from 'url';

const app = express();
const port = 3000;
const API_URL = "https://covers.openlibrary.org/b"; // base
const coverUrl = (isbn, size="L") =>
  isbn ? `${API_URL}/isbn/${isbn}-${size}.jpg?default=false` : null;

const amazonLink = (isbn, title, author) => {
  if (isbn && String(isbn).trim()) {
    // точный поиск по ISBN
    return `https://www.amazon.com/s?k=${encodeURIComponent(String(isbn).trim())}`;
  }
  // fallback — поиск по названию и автору
  const q = [title, author].filter(Boolean).join(" ");
  return `https://www.amazon.com/s?k=${encodeURIComponent(q)}`;
};

const db = new pg.Client({
  user: "postgres",
  host: "localhost",
  database: "my_lib_books",
  password: "DF12qazws",
  port: 5432,
});
db.connect();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));




app.get("/", async (req, res) => {
  const sort = (req.query.sort || "best").toLowerCase(); // тут req доступен
  const order = (req.query.order || (sort==="title" ? "asc" : "desc")).toUpperCase();

  const sortSql = {
    best:   `rating ${order} NULLS LAST, read_date DESC NULLS LAST, lower(books_name) ASC`,
    newest: `read_date ${order} NULLS LAST, rating DESC NULLS LAST, lower(books_name) ASC`,
    title:  `lower(books_name) ${order}, read_date DESC NULLS LAST`
  }[sort] || `rating DESC NULLS LAST, read_date DESC NULLS LAST`;

  const { rows: books } = await db.query(
    `SELECT id, books_name, author, isbn, read_date, rating
     FROM lib_books
     ORDER BY ${sortSql}`
  );

  const withCovers = books.map(b => ({
    ...b,
    cover: coverUrl(b.isbn) || "/placeholder.png",
    buyUrl: amazonLink(b.isbn, b.books_name, b.author)
  }));

  res.render("index.ejs", {
    title: "My Read Books",
    books: withCovers,
    sort,
    order
  });
});
  
app.get("/books/:id", async (req, res) => {
  const { id } = req.params;
  const { rows } = await db.query("SELECT * FROM lib_books WHERE id=$1", [id]);
  if (!rows[0]) return res.status(404).send("Not found");
  const book = rows[0];
  book.cover = coverUrl(book.isbn) || "/placeholder.png";
  book.buyUrl = amazonLink(book.isbn, book.books_name, book.author);
  res.render("book.ejs", { title: "Book details", book });
});
  
  // adding form
app.get("/new", (req, res) => res.render("new.ejs", {
  title: "Add a book"
}));

// add book
app.post("/books", async (req, res) => {
  const { books_name, author, isbn, read_date, rating } = req.body;
  await db.query(
    `INSERT INTO lib_books (books_name, author, isbn, read_date, rating)
     VALUES ($1,$2,$3,$4,$5)`,
    [books_name, author, isbn || null,read_date || null, rating || null]
  );
  res.redirect("/");
});

// update book

app.post("/books/:id/update-meta", async (req, res) => {
  const { id } = req.params;
  const { books_name, author, isbn } = req.body;

  await db.query(
    `UPDATE lib_books
     SET books_name=$1, author=$2, isbn=$3
     WHERE id=$4`,
    [books_name, author, isbn || null, id]
  );

  res.redirect(`/books/${id}`);
});
// delete book
app.post("/books/:id/delete", async (req, res) => {
  const { id } = req.params;
  await db.query("DELETE FROM lib_books WHERE id=$1", [id]);
  res.redirect("/");
});

// ---------- REST API (JSON) ----------
app.get("/api/books", async (req, res) => {
  const { rows } = await db.query("SELECT * FROM lib_books ORDER BY id DESC");
  res.json(rows);
});

app.get("/api/books/:id", async (req, res) => {
  const { rows } = await db.query("SELECT * FROM lib_books WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

app.post("/api/books", express.json(), async (req, res) => {
  const { books_name, author, isbn, notes, read_date, rating } = req.body;
  const { rows } = await db.query(
    `INSERT INTO lib_books (books_name, author, isbn,notes, read_date, rating)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
     [books_name, author, isbn || null, notes || null, read_date || null, rating || null]
  );
  res.status(201).json(rows[0]);
});

app.listen(port, () => console.log(`BookNotes running on http://localhost:${port}`));