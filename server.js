const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

const BASEROW_API = 'https://api.baserow.io/api/database/rows/table';
const BASEROW_TOKEN = process.env.BASEROW_TOKEN;

app.use(express.json());

function proxyBaserow(req, res, method = 'GET', body = null) {
  const { tableId, rowId } = req.params;

  const url = rowId
    ? `${BASEROW_API}/${tableId}/${rowId}/?user_field_names=true`
    : `${BASEROW_API}/${tableId}/?user_field_names=true`;

  if (!BASEROW_TOKEN) {
    return res.status(500).json({ error: 'Falta BASEROW_TOKEN en el servidor' });
  }

  const options = {
    method,
    headers: {
      Authorization: `Token ${BASEROW_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  fetch(url, options)
    .then(async (response) => {
      const text = await response.text();

      try {
        const json = JSON.parse(text);
        res.status(response.status).json(json);
      } catch {
        res.status(response.status).send(text);
      }
    })
    .catch((error) => {
      console.error('Error al consultar Baserow:', error);
      res.status(500).json({ error: 'Error al consultar Baserow' });
    });
}

// GET all rows
app.get('/api/baserow/rows/:tableId', (req, res) => {
  proxyBaserow(req, res, 'GET', null);
});

// POST row
app.post('/api/baserow/rows/:tableId', (req, res) => {
  proxyBaserow(req, res, 'POST', req.body);
});

// PATCH row
app.patch('/api/baserow/rows/:tableId/:rowId', (req, res) => {
  proxyBaserow(req, res, 'PATCH', req.body);
});

// DELETE row
app.delete('/api/baserow/rows/:tableId/:rowId', (req, res) => {
  proxyBaserow(req, res, 'DELETE', null);
});

app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
