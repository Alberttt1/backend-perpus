// backend/index.js
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Koneksi ke Railway PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ─── BOOKS CRUD ───────────────────────────────────────

// GET all books
app.get('/api/books', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM books ORDER BY title');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create book
app.post('/api/books', async (req, res) => {
  const { title, author, isbn, category, total_copies } = req.body;
  if (!title || !author || !category || total_copies == null) {
    return res.status(400).json({ error: 'Title, author, category, and copies are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO books (title, author, isbn, category, total_copies, available_copies)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [title, author, isbn || null, category, parseInt(total_copies)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update book
app.put('/api/books/:id', async (req, res) => {
  const { id } = req.params;
  const { title, author, isbn, category, total_copies } = req.body;
  if (!title || !author || !category || total_copies == null) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    // Get current stock
    const current = await pool.query('SELECT total_copies, available_copies FROM books WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Book not found' });

    const oldTotal = current.rows[0].total_copies;
    const newAvailable = parseInt(total_copies) - (oldTotal - current.rows[0].available_copies);

    const result = await pool.query(
      `UPDATE books SET title=$1, author=$2, isbn=$3, category=$4, total_copies=$5, available_copies=$6
       WHERE id=$7 RETURNING *`,
      [title, author, isbn || null, category, parseInt(total_copies), newAvailable, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE book
app.delete('/api/books/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM books WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Book not found' });
    res.json({ message: 'Book deleted' });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'Cannot delete: book has active borrowings' });
    res.status(500).json({ error: err.message });
  }
});

// ─── BORROWINGS CRUD ───────────────────────────────────

// GET all borrowings
app.get('/api/borrowings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, bk.title as book_title, bk.author as book_author
      FROM borrowings b
      JOIN books bk ON b.book_id = bk.id
      ORDER BY b.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create borrowing
app.post('/api/borrowings', async (req, res) => {
  const { book_id, borrower_name } = req.body;
  if (!book_id || !borrower_name) {
    return res.status(400).json({ error: 'Book and borrower name are required' });
  }

  try {
    // Check availability of the book
    const book = await pool.query('SELECT available_copies FROM books WHERE id = $1', [book_id]);
    if (book.rows.length === 0) return res.status(404).json({ error: 'Book not found' });
    if (book.rows[0].available_copies <= 0) return res.status(400).json({ error: 'Book is not available' });

    // Reduce stock
    await pool.query('UPDATE books SET available_copies = available_copies - 1 WHERE id = $1', [book_id]);

    // Create borrowing
    const result = await pool.query(
      `INSERT INTO borrowings (book_id, borrower_name)
       VALUES ($1, $2) RETURNING *`,
      [book_id, borrower_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT return book
app.put('/api/borrowings/:id/return', async (req, res) => {
  const { id } = req.params;
  try {
    // Check if already returned
    const current = await pool.query('SELECT book_id, status FROM borrowings WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Borrowing not found' });
    if (current.rows[0].status === 'returned') return res.status(400).json({ error: 'Book already returned' });

    // Update status & increase stock
    await pool.query('UPDATE books SET available_copies = available_copies + 1 WHERE id = $1', [current.rows[0].book_id]);
    const result = await pool.query(
      'UPDATE borrowings SET status = $1, return_date = CURRENT_DATE WHERE id = $2 RETURNING *',
      ['returned', id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE borrowing
app.delete('/api/borrowings/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Only allow deletion if not returned
    const current = await pool.query('SELECT book_id, status FROM borrowings WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Borrowing not found' });
    if (current.rows[0].status === 'returned') return res.status(400).json({ error: 'Cannot delete returned borrowing' });

    // Restore stock
    await pool.query('UPDATE books SET available_copies = available_copies + 1 WHERE id = $1', [current.rows[0].book_id]);
    await pool.query('DELETE FROM borrowings WHERE id = $1', [id]);
    res.json({ message: 'Borrowing canceled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Handle Vercel serverless function
module.exports = app;