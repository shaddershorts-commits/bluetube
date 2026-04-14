-- LIPY — schema Supabase (prefixo lipy_)
-- Executar no SQL editor do Supabase (mesmo projeto do BlueTube)

CREATE TABLE IF NOT EXISTS lipy_clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  empresa TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  telefone TEXT,
  whatsapp_group_id TEXT,
  trello_board_id TEXT,
  plano TEXT DEFAULT 'starter',
  status TEXT DEFAULT 'onboarding',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  nicho TEXT,
  meta_page_id TEXT,
  meta_instagram_id TEXT,
  meta_access_token TEXT,
  configuracoes JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lipy_planejamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID REFERENCES lipy_clientes(id) ON DELETE CASCADE,
  mes_referencia TEXT NOT NULL,
  objetivo TEXT,
  publico_alvo TEXT,
  tom_comunicacao TEXT,
  cores_marca TEXT[],
  temas TEXT[],
  frequencia_posts INTEGER DEFAULT 12,
  status TEXT DEFAULT 'rascunho',
  aprovado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lipy_conteudos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID REFERENCES lipy_clientes(id) ON DELETE CASCADE,
  planejamento_id UUID REFERENCES lipy_planejamentos(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL,
  plataforma TEXT NOT NULL,
  titulo TEXT,
  legenda TEXT,
  hashtags TEXT[],
  imagem_url TEXT,
  video_url TEXT,
  status TEXT DEFAULT 'rascunho',
  agendado_para TIMESTAMPTZ,
  publicado_em TIMESTAMPTZ,
  meta_post_id TEXT,
  feedback_cliente TEXT,
  metricas JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lipy_conversas_whatsapp (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID REFERENCES lipy_clientes(id) ON DELETE CASCADE,
  group_id TEXT,
  mensagem TEXT NOT NULL,
  remetente TEXT NOT NULL,
  tipo TEXT DEFAULT 'texto',
  processado BOOLEAN DEFAULT FALSE,
  resposta_agente TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lipy_campanhas_trafego (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID REFERENCES lipy_clientes(id) ON DELETE CASCADE,
  plataforma TEXT NOT NULL,
  nome TEXT NOT NULL,
  objetivo TEXT NOT NULL,
  orcamento_diario DECIMAL,
  orcamento_total DECIMAL,
  data_inicio DATE,
  data_fim DATE,
  status TEXT DEFAULT 'rascunho',
  meta_campaign_id TEXT,
  metricas JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lipy_relatorios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID REFERENCES lipy_clientes(id) ON DELETE CASCADE,
  periodo_inicio DATE NOT NULL,
  periodo_fim DATE NOT NULL,
  tipo TEXT DEFAULT 'semanal',
  dados JSONB NOT NULL,
  pdf_url TEXT,
  enviado_whatsapp BOOLEAN DEFAULT FALSE,
  enviado_email BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lipy_tarefas_agentes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID REFERENCES lipy_clientes(id) ON DELETE CASCADE,
  agente TEXT NOT NULL,
  tipo TEXT NOT NULL,
  status TEXT DEFAULT 'pendente',
  dados_entrada JSONB,
  dados_saida JSONB,
  erro TEXT,
  tentativas INTEGER DEFAULT 0,
  proxima_tentativa TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  concluido_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS lipy_onboarding_respostas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID REFERENCES lipy_clientes(id) ON DELETE CASCADE,
  etapa TEXT NOT NULL,
  respostas JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lipy_clientes_status ON lipy_clientes(status);
CREATE INDEX IF NOT EXISTS idx_lipy_conteudos_cliente ON lipy_conteudos(cliente_id, status);
CREATE INDEX IF NOT EXISTS idx_lipy_conteudos_agendado ON lipy_conteudos(agendado_para) WHERE status='agendado';
CREATE INDEX IF NOT EXISTS idx_lipy_tarefas_status ON lipy_tarefas_agentes(status, proxima_tentativa);
CREATE INDEX IF NOT EXISTS idx_lipy_conversas_group ON lipy_conversas_whatsapp(group_id);
