import * as dotenv from 'dotenv';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import express from 'express';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const BASEROW_API = 'https://api.baserow.io/api/database/rows/table';
const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
const PIN_CONFIG_TABLE_ID = process.env.PIN_CONFIG_TABLE_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;

const allowedOrigins = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!BASEROW_TOKEN || !PIN_CONFIG_TABLE_ID || !SESSION_SECRET) {
  throw new Error('Faltan variables obligatorias en .env');
}

// Necesario cuando el backend está detrás de un proxy HTTPS en producción.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(cors({
  origin(origin, callback) {
    // Permite pruebas desde herramientas sin origin, como curl o Postman.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origen no permitido por CORS'));
  },
  credentials: true
}));

app.use(express.json());

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 8 * 60 * 60 * 1000 // 8 horas
  }
}));

async function obtenerHashPin() {
  const url = `${BASEROW_API}/${PIN_CONFIG_TABLE_ID}/?user_field_names=true`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Token ${BASEROW_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error('No se pudo leer la configuración del PIN');
  }

  const datos = await response.json();
  const fila = (datos.results || []).find(
    (item) => item.Nombre === 'pin_acceso' && item.Activo === true
  );

  if (!fila?.['Pin_hash']) {
    throw new Error('No existe una configuración activa de PIN');
  }

  return fila['Pin_hash'];
}

const limitadorPin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo más tarde.' }
});

// control de intentos progresivos por IPPPP 
const intentosPin = new Map(); // ip -> {fallos: number, bloqueadoHasta: number}
// Duracion de bloqueo según el número de fallos consecutivos
const ESPERAS_SEGUNDOS = [0, 60, 180, 300]; 

function segundosDeEspera(fallos) {
  const indice = Math.min(fallos, ESPERAS_SEGUNDOS.length - 1);
  return ESPERAS_SEGUNDOS[indice];
}

function obtenerEstado(ip){
  return intentosPin.get(ip) || { fallos: 0, bloqueadoHasta: 0 };
}

function registrarFallo(ip){
  const estado = obtenerEstado(ip);
    estado.fallos += 1;
    estado.bloqueadoHasta = Date.now() + segundosDeEspera(estado.fallos) * 1000;
    intentosPin.set(ip, estado);
    return estado;
  }

  function limpiarIntentos(ip){
    intentosPin.delete(ip);
  }

  // limpieza periodica para no acumular ip viejas
  setInterval(() =>
  {
    const ahora = Date.now();
    for(const [ip, estado] of intentosPin.entries()) {
      if(estado.bloqueadoHasta < ahora) intentosPin.delete(ip);
    }
  }, 10*60*1000);

app.post('/api/auth/pin', async (req, res) => {
  const ip = req.ip;
  const { pin } = req.body;

  const estado = obtenerEstado(ip);
  const ahora = Date.now();

  if(estado.bloqueadoHasta > ahora) {
    const segundosRestantes = Math.ceil((estado.bloqueadoHasta - ahora) / 1000);
    return res.status(429).json({
      error: 'Demasiados intentos fallidos. Espera antes de volver a intentar.',
      segundosRestantes
    }); 
  }

  if (!/^\d{6}$/.test(pin || '')) {
    return res.status(400).json({ error: 'El PIN debe tener seis dígitos.' });
  }

  try {
    const hashPin = await obtenerHashPin();
    const esValido = await bcrypt.compare(pin, hashPin);

    if(!esValido) {
      const nuevoEstado = registrarFallo(ip);
      const segundosRestantes = segundosDeEspera(nuevoEstado.fallos);
      return res.status(401).json({
        error: 'Pin Incorrecto',
        segundosRestantes
      });
    }

    limpiarIntentos(ip);
    req.session.accesoCookly = true;
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error al validar el PIN', error.message);
    return res.status(500).json({ error: 'No fue posible validar el acceso'});
  }
});

app.get('/api/auth/session', (req, res) => {
  res.json({ autenticado: Boolean(req.session.accesoCookly) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

function requiereAcceso(req, res, next) {
  if (req.session?.accesoCookly) {
    return next();
  }

  return res.status(401).json({ error: 'Acceso no autorizado.' });
}


app.use('/api/baserow', requiereAcceso);

function proxyBaserow(req, res, method = 'GET', body = null) {
  const { tableId, rowId } = req.params;

  const url = rowId
    ? `${BASEROW_API}/${tableId}/${rowId}/?user_field_names=true`
    : `${BASEROW_API}/${tableId}/?user_field_names=true`;

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
        res.status(response.status).json(JSON.parse(text));
      } catch {
        res.status(response.status).send(text);
      }
    })
    .catch((error) => {
      console.error('Error al consultar Baserow:', error);
      res.status(500).json({ error: 'Error al consultar Baserow' });
    });
}

app.get('/api/baserow/rows/:tableId', (req, res) => {
  proxyBaserow(req, res, 'GET');
});

app.post('/api/baserow/rows/:tableId', (req, res) => {
  proxyBaserow(req, res, 'POST', req.body);
});

app.patch('/api/baserow/rows/:tableId/:rowId', (req, res) => {
  proxyBaserow(req, res, 'PATCH', req.body);
});

app.delete('/api/baserow/rows/:tableId/:rowId', (req, res) => {
  proxyBaserow(req, res, 'DELETE');
});

app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});