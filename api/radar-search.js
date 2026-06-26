// ══════════════════════════════════════════════════════════════
// CONCRE ERP — Radar Comercial IA
// Servidor intermediario (Vercel Serverless Function)
// Protege las claves de Google Places y Tavily — el navegador
// nunca las ve. Solo responde si recibe el token secreto correcto.
// ══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS: permite que el ERP (en su dominio) llame a esta función
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-radar-token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Use POST.' });
  }

  // ── Seguridad: verificar el token secreto ──
  const tokenRecibido = req.headers['x-radar-token'];
  if (!tokenRecibido || tokenRecibido !== process.env.RADAR_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Token inválido o ausente.' });
  }

  const { tipo, query, zona, categoria } = req.body || {};

  if (!tipo) {
    return res.status(400).json({ error: 'Falta el campo "tipo" (google_places | tavily).' });
  }

  try {
    if (tipo === 'google_places') {
      const resultado = await buscarGooglePlaces(query, zona, categoria);
      return res.status(200).json(resultado);
    }

    if (tipo === 'tavily') {
      const resultado = await buscarTavily(query);
      return res.status(200).json(resultado);
    }

    return res.status(400).json({ error: 'Tipo de búsqueda no reconocido.' });

  } catch (err) {
    console.error('radar-search error:', err);
    return res.status(500).json({ error: 'Error interno al consultar la fuente externa.', detalle: err.message });
  }
}

// ── Google Places API (New) — Text Search ──
async function buscarGooglePlaces(query, zona, categoria) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY no configurada en Vercel.');

  const textoQuery = `${categoria || ''} ${query || ''} ${zona || 'Costa Rica'}`.trim();

  const url = 'https://places.googleapis.com/v1/places:searchText';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      // FieldMask: solo pedimos los campos que necesitamos (más barato = nivel Essentials)
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.googleMapsUri,places.types'
    },
    body: JSON.stringify({
      textQuery: textoQuery,
      languageCode: 'es',
      maxResultCount: 20
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Google Places respondió ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const places = data.places || [];

  return {
    fuente: 'google_places',
    total: places.length,
    resultados: places.map(p => ({
      nombre: p.displayName?.text || 'Sin nombre',
      direccion: p.formattedAddress || '',
      telefono: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
      sitio_web: p.websiteUri || '',
      calificacion: p.rating || null,
      num_resenas: p.userRatingCount || 0,
      google_maps_url: p.googleMapsUri || '',
      categorias: p.types || []
    }))
  };
}

// ── Tavily — búsqueda web (noticias, LinkedIn público, señales recientes) ──
async function buscarTavily(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY no configurada en Vercel.');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query,
      search_depth: 'basic',
      include_answer: false,
      max_results: 8
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Tavily respondió ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const resultados = data.results || [];

  return {
    fuente: 'tavily',
    total: resultados.length,
    resultados: resultados.map(r => ({
      titulo: r.title || '',
      url: r.url || '',
      contenido: r.content || '',
      score_relevancia: r.score || 0
    }))
  };
}
