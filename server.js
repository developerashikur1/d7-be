// server.js
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import querystring from 'querystring';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

// Store tokens in memory (use database in production)
const tokenStore = new Map();

// GoHighLevel OAuth Configuration
const GHL_CONFIG = {
  clientId: process.env.GHL_CLIENT_ID,
  clientSecret: process.env.GHL_CLIENT_SECRET,
  redirectUri: process.env.GHL_REDIRECT_URI,
  authUrl: 'https://marketplace.gohighlevel.com/oauth/chooselocation',
  tokenUrl: 'https://services.leadconnectorhq.com/oauth/token',
  apiBaseUrl: 'https://services.leadconnectorhq.com'
};

// D7 LeadFinder Configuration
const D7_API_KEY = process.env.D7_API_KEY;

// Routes

// 1. Generate OAuth URL
app.get('/auth/gohighlevel/url', (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  const params = {
    response_type: 'code',
    client_id: GHL_CONFIG.clientId,
    redirect_uri: GHL_CONFIG.redirectUri,
    scope: 'contacts.write contacts.readonly locations.readonly',
    state: state
  };
  
  const authUrl = `${GHL_CONFIG.authUrl}?${querystring.stringify(params)}`;
  
  res.json({
    success: true,
    authUrl: authUrl,
    state: state
  });
});

// 2. Handle OAuth Callback
app.get('/auth/gohighlevel/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'Authorization code not provided' });
  }

  try {
    // Exchange code for token
    const tokenResponse = await axios.post(GHL_CONFIG.tokenUrl, {
      grant_type: 'authorization_code',
      client_id: GHL_CONFIG.clientId,
      client_secret: GHL_CONFIG.clientSecret,
      code: code,
      redirect_uri: GHL_CONFIG.redirectUri
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const tokenData = tokenResponse.data;
    
    // Store tokens (use user ID in production)
    const userId = 'default_user'; // Replace with actual user identification
    tokenStore.set(userId, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in * 1000),
      location_id: tokenData.locationId,
      company_id: tokenData.companyId,
      scope: tokenData.scope
    });

    // Redirect to frontend success page
    res.redirect(`${process.env.FRONTEND_URL}/auth/success?location_id=${tokenData.locationId}`);
    
  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to exchange authorization code',
      details: error.response?.data || error.message 
    });
  }
});

// 3. Get user's authenticated locations/sub-accounts
app.get('/api/locations', async (req, res) => {
  const userId = 'default_user'; // Replace with actual user identification
  const tokens = tokenStore.get(userId);
  
  if (!tokens) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  try {
    // Check if token needs refresh
    if (Date.now() >= tokens.expires_at) {
      await refreshAccessToken(userId);
    }

    const updatedTokens = tokenStore.get(userId);
    
    // Get company locations (sub-accounts)
    const response = await axios.get(`${GHL_CONFIG.apiBaseUrl}/locations/search`, {
      headers: {
        Authorization: `Bearer ${updatedTokens.access_token}`,
        Version: '2021-07-28'
      },
      params: {
        companyId: updatedTokens.company_id,
        limit: 100
      }
    });

    res.json({
      success: true,
      locations: response.data.locations || [],
      current_location: updatedTokens.location_id
    });
    
  } catch (error) {
    console.error('Get locations error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch locations',
      details: error.response?.data || error.message 
    });
  }
});

// 4. Get D7 leads data
app.get('/api/d7-leads', async (req, res) => {
  try {
    // Replace with actual D7 LeadFinder API endpoint
    const d7Response = await axios.get('https://api.d7leadfinder.com/leads', {
      headers: {
        'Authorization': `Bearer ${D7_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({
      success: true,
      leads: d7Response.data.leads || d7Response.data
    });
    
  } catch (error) {
    console.error('D7 API error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch D7 leads',
      details: error.response?.data || error.message 
    });
  }
});

// 5. Export leads to selected GoHighLevel location
app.post('/api/export-leads', async (req, res) => {
  const { leads, locationId } = req.body;
  const userId = 'default_user'; // Replace with actual user identification
  const tokens = tokenStore.get(userId);
  
  if (!tokens) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  if (!leads || !Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'No leads provided' });
  }

  try {
    // Check if token needs refresh
    if (Date.now() >= tokens.expires_at) {
      await refreshAccessToken(userId);
    }

    const updatedTokens = tokenStore.get(userId);
    const targetLocationId = locationId || updatedTokens.location_id;
    
    const results = [];
    
    // Export each lead
    for (const lead of leads) {
      try {
        const contactData = {
          firstName: lead.firstName || lead.first_name || '',
          lastName: lead.lastName || lead.last_name || '',
          email: lead.email || '',
          phone: lead.phone || lead.phoneNumber || '',
          address1: lead.address || lead.address1 || '',
          city: lead.city || '',
          state: lead.state || '',
          country: lead.country || 'US',
          postalCode: lead.zipCode || lead.postalCode || '',
          website: lead.website || '',
          timezone: lead.timezone || 'America/New_York',
          source: 'D7 LeadFinder Import',
          tags: ['D7Import', 'Lead']
        };

        const response = await axios.post(
          `${GHL_CONFIG.apiBaseUrl}/contacts/`,
          contactData,
          {
            headers: {
              Authorization: `Bearer ${updatedTokens.access_token}`,
              Version: '2021-07-28',
              'Content-Type': 'application/json'
            },
            params: {
              locationId: targetLocationId
            }
          }
        );

        results.push({
          success: true,
          leadId: lead.id || lead._id,
          contactId: response.data.contact?.id,
          email: contactData.email
        });
        
      } catch (leadError) {
        console.error(`Failed to export lead ${lead.email}:`, leadError.response?.data);
        results.push({
          success: false,
          leadId: lead.id || lead._id,
          email: lead.email,
          error: leadError.response?.data?.message || leadError.message
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      message: `Exported ${successCount} leads successfully, ${failureCount} failed`,
      results: results,
      summary: {
        total: leads.length,
        success: successCount,
        failed: failureCount
      }
    });
    
  } catch (error) {
    console.error('Export leads error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to export leads',
      details: error.response?.data || error.message 
    });
  }
});

// 6. Check authentication status
app.get('/api/auth/status', (req, res) => {
  const userId = 'default_user'; // Replace with actual user identification
  const tokens = tokenStore.get(userId);
  
  if (!tokens) {
    return res.json({ authenticated: false });
  }

  // Check if token is expired
  const isExpired = Date.now() >= tokens.expires_at;
  
  res.json({
    authenticated: !isExpired,
    location_id: tokens.location_id,
    company_id: tokens.company_id,
    expires_at: tokens.expires_at
  });
});

// 7. Refresh access token
async function refreshAccessToken(userId) {
  const tokens = tokenStore.get(userId);
  
  if (!tokens || !tokens.refresh_token) {
    throw new Error('No refresh token available');
  }

  try {
    const response = await axios.post(GHL_CONFIG.tokenUrl, {
      grant_type: 'refresh_token',
      client_id: GHL_CONFIG.clientId,
      client_secret: GHL_CONFIG.clientSecret,
      refresh_token: tokens.refresh_token
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const newTokenData = response.data;
    
    // Update stored tokens
    tokenStore.set(userId, {
      ...tokens,
      access_token: newTokenData.access_token,
      expires_at: Date.now() + (newTokenData.expires_in * 1000),
      refresh_token: newTokenData.refresh_token || tokens.refresh_token
    });

    return newTokenData;
    
  } catch (error) {
    console.error('Token refresh error:', error.response?.data || error.message);
    // Remove invalid tokens
    tokenStore.delete(userId);
    throw new Error('Failed to refresh token');
  }
}



// Express route: /auth/gohighlevel/callback
app.get('/auth/gohighlevel/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("Missing code");
  }

  try {
    const response = await axios.post('https://api.gohighlevel.com/oauth/token', {
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.NEXT_PUBLIC_GHL_REDIRECT_URI,
    });

    const { access_token, refresh_token } = response.data;

    // Save tokens securely for later use
    console.log("Access Token:", access_token);

    return res.send("GHL Auth successful! You can now export leads.");
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth token exchange failed.");
  }
});


// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: error.message 
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`GoHighLevel OAuth configured with Client ID: ${GHL_CONFIG.clientId}`);
});

export default app;