const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = async (req, res) => {
  try {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Verificar autenticação
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de acesso não fornecido' });
    }

    const token = authHeader.substring(7);
    
    // Verificar usuário autenticado
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    // Buscar dados do usuário e plano
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (userError) {
      console.error('Erro ao buscar usuário:', userError);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }

    // Verificar se userData existe e tem propriedades necessárias
    if (!userData) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Definir plano padrão caso não exista
    const planData = {
      plan: userData.plan || 'free',
      planStatus: userData.plan_status || 'active',
      subscriptionId: userData.subscription_id || null,
      planLimits: {
        shorts: userData.shorts_limit || 3,
        used: userData.shorts_used || 0
      },
      features: {
        blueChat: userData.plan === 'pro' || userData.plan === 'premium',
        blueVoices: userData.plan === 'premium',
        blueEditor: userData.plan === 'pro' || userData.plan === 'premium',
        unlimited: userData.plan === 'premium'
      }
    };

    return res.status(200).json({
      success: true,
      data: planData
    });

  } catch (error) {
    console.error('Erro em get-plan:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};