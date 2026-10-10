(() => {
  'use strict';

  const stageLabels = {
    prospect: 'Prospect', invited: 'Convidado', opted_in: 'Opt-in confirmado',
    interested: 'Interessado', first_buyer: 'Primeira compra',
    repeat_buyer: 'Cliente recorrente', inactive: 'Inativo', blocked: 'Bloqueado',
  };
  const originLabels = {
    manual: 'Manual', manual_crm: 'CRM', whatsapp: 'WhatsApp', instagram: 'Instagram',
    indicacao: 'Indicação', site: 'Site', formulario: 'Formulário',
  };
  const viewLabels = {
    dashboard: 'Visão geral', contacts: 'Contatos', products: 'Produtos',
    campaigns: 'Campanhas', integrations: 'Integrações',
  };
  const campaignStatusLabels = {
    draft: 'Rascunho', preflight_ready: 'Análise pronta', approved: 'Aprovada',
    scheduled: 'Agendada', sending: 'Enviando', completed: 'Concluída', cancelled: 'Cancelada',
  };
  const campaignStatusClass = {
    draft: 'neutral', preflight_ready: 'accent', approved: 'success',
    scheduled: 'success', sending: 'success', completed: 'neutral', cancelled: 'danger',
  };
  const exclusionLabels = {
    invalid_phone: 'Telefone inválido', do_not_contact: 'Não contatar', blocked: 'Bloqueado',
    marketing_consent_missing: 'Sem consentimento', cooldown: 'Em cooldown',
    frequency_cap: 'Limite de frequência', stage_not_selected: 'Etapa excluída',
    origin_not_selected: 'Origem excluída', tag_not_selected: 'Tag ausente', already_converted: 'Já convertido',
  };
  const state = {
    token: sessionStorage.getItem('samjoe_crm_token') || '',
    user: null,
    contacts: [],
    products: [],
    campaigns: [],
    activeView: 'dashboard',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
  const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  const money = (cents) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((Number(cents) || 0) / 100);
  const shortDate = (date) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(date));
  const relativeDate = (date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
    if (days <= 0) return 'Hoje';
    if (days === 1) return 'Ontem';
    if (days < 30) return `${days} dias`;
    return shortDate(date);
  };

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/v1/auth/login') logout(false);
      throw new Error(payload.error?.message || `Erro ${response.status}`);
    }
    return payload;
  }

  function setButtonLoading(button, loading, label = 'Salvando...') {
    if (!button) return;
    if (loading) {
      button.dataset.original = button.innerHTML;
      button.textContent = label;
      button.disabled = true;
    } else {
      button.innerHTML = button.dataset.original || button.innerHTML;
      button.disabled = false;
    }
  }

  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    $('#toastRegion').append(node);
    window.setTimeout(() => node.remove(), 3800);
  }

  async function checkHealth() {
    const dot = $('#apiDot');
    try {
      const result = await api('/health');
      const healthy = result.status === 'ok' && result.database === 'ok';
      dot.classList.toggle('ok', healthy);
      $('#apiStateText').textContent = healthy ? 'API e banco online' : 'Serviço degradado';
      $('#apiBadge').textContent = healthy ? 'Online' : 'Degradada';
      $('#apiBadge').className = `status-badge ${healthy ? 'success' : 'danger'}`;
    } catch {
      dot.classList.remove('ok');
      $('#apiStateText').textContent = 'API indisponível';
      $('#apiBadge').textContent = 'Offline';
      $('#apiBadge').className = 'status-badge danger';
    }
  }

  async function login(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('#loginError');
    error.textContent = '';
    setButtonLoading(submit, true, 'Entrando...');
    try {
      const data = Object.fromEntries(new FormData(form));
      const result = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(data) });
      state.token = result.access_token;
      state.user = result.user;
      sessionStorage.setItem('samjoe_crm_token', state.token);
      await enterApp();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  function logout(showMessage = true) {
    state.token = '';
    state.user = null;
    state.contacts = [];
    state.products = [];
    sessionStorage.removeItem('samjoe_crm_token');
    $('#appShell').classList.add('is-hidden');
    $('#loginScreen').classList.remove('is-hidden');
    $('#passwordInput').value = '';
    if (showMessage) toast('Sessão encerrada.');
  }

  async function enterApp() {
    $('#loginScreen').classList.add('is-hidden');
    $('#appShell').classList.remove('is-hidden');
    $('#userEmail').textContent = state.user?.email || 'Usuário';
    $('#userRole').textContent = state.user?.role || 'Operação local';
    $('#userInitial').textContent = initials(state.user?.email || 'S');
    $('#welcomeName').textContent = 'time SamJoE';
    await loadData();
  }

  async function restoreSession() {
    if (!state.token) return;
    try {
      state.user = await api('/api/v1/me');
      await enterApp();
    } catch {
      logout(false);
    }
  }

  async function loadData(showConfirmation = false) {
    $('#refreshButton').classList.add('is-spinning');
    try {
      const [contactsResult, productsResult, campaignsResult] = await Promise.all([
        api('/api/v1/contacts?limit=200'),
        api('/api/v1/products'),
        api('/api/v1/campaigns'),
      ]);
      state.contacts = contactsResult.data || [];
      state.products = productsResult.data || [];
      state.campaigns = campaignsResult.data || [];
      renderAll();
      if (showConfirmation) toast('Dados atualizados.');
    } catch (err) {
      toast(`Não foi possível carregar os dados: ${err.message}`, 'error');
    } finally {
      $('#refreshButton').classList.remove('is-spinning');
      checkHealth();
    }
  }

  function renderAll() {
    renderMetrics();
    renderStages();
    renderRecent();
    renderContacts();
    renderProducts();
    renderCampaigns();
    $('#contactNavCount').textContent = String(state.contacts.length);
    $('#campaignNavCount').textContent = String(state.campaigns.length);
  }

  function renderMetrics() {
    const monthAgo = Date.now() - 30 * 86400000;
    const prospects = state.contacts.filter((contact) => ['prospect', 'invited', 'opted_in', 'interested'].includes(contact.stage)).length;
    const newContacts = state.contacts.filter((contact) => new Date(contact.created_at).getTime() >= monthAgo).length;
    $('#metricContacts').textContent = String(state.contacts.length);
    $('#metricNewContacts').textContent = `${newContacts} ${newContacts === 1 ? 'novo' : 'novos'}`;
    $('#metricProspects').textContent = String(prospects);
    $('#metricProducts').textContent = String(state.products.filter((product) => product.active).length);
    $('#metricOptOut').textContent = String(state.contacts.filter((contact) => contact.do_not_contact).length);
  }

  function renderStages() {
    const counts = Object.keys(stageLabels).map((stage) => ({
      stage, count: state.contacts.filter((contact) => contact.stage === stage).length,
    }));
    const max = Math.max(...counts.map(({ count }) => count), 1);
    $('#stageList').innerHTML = counts.map(({ stage, count }) => `
      <div class="stage-row">
        <span>${stageLabels[stage]}</span>
        <div class="progress-track"><div class="progress-fill" style="width:${(count / max) * 100}%"></div></div>
        <b>${count}</b>
      </div>`).join('');
  }

  function renderRecent() {
    const recent = state.contacts.slice(0, 5);
    $('#recentContacts').innerHTML = recent.length ? recent.map((contact) => `
      <div class="activity-item">
        <span class="avatar">${escapeHtml(initials(contact.full_name))}</span>
        <span><strong>${escapeHtml(contact.full_name)}</strong><small>${escapeHtml(originLabels[contact.origin] || contact.origin)} · ${escapeHtml(stageLabels[contact.stage] || contact.stage)}</small></span>
        <time>${relativeDate(contact.created_at)}</time>
      </div>`).join('') : '<p class="list-placeholder">Os contatos recém-cadastrados aparecerão aqui.</p>';
  }

  function filteredContacts() {
    const search = $('#contactSearch').value.trim().toLowerCase();
    const stage = $('#stageFilter').value;
    return state.contacts.filter((contact) => {
      const haystack = `${contact.full_name} ${contact.phone_e164 || ''} ${contact.email || ''}`.toLowerCase();
      return (!search || haystack.includes(search)) && (!stage || contact.stage === stage);
    });
  }

  function renderContacts() {
    const contacts = filteredContacts();
    const body = $('#contactsTableBody');
    body.innerHTML = contacts.map((contact) => `
      <tr>
        <td><div class="contact-cell"><span class="avatar">${escapeHtml(initials(contact.full_name))}</span><span><strong>${escapeHtml(contact.full_name)}</strong><small>${escapeHtml(contact.phone_e164 || contact.email || 'Sem telefone ou e-mail')}</small></span></div></td>
        <td><span class="stage-badge ${escapeHtml(contact.stage)}">${escapeHtml(stageLabels[contact.stage] || contact.stage)}</span></td>
        <td>${escapeHtml(originLabels[contact.origin] || contact.origin)}</td>
        <td><span class="permission ${contact.do_not_contact ? 'blocked' : 'ok'}">${contact.do_not_contact ? '● Bloqueado' : '● Permitido'}</span></td>
        <td>${shortDate(contact.created_at)}</td>
        <td><button class="row-action" data-consent-id="${contact.id}" data-consent-name="${escapeHtml(contact.full_name)}">Consentimento</button></td>
      </tr>`).join('');
    const empty = !contacts.length;
    $('#contactsEmpty').classList.toggle('is-hidden', !empty);
    $('.table-wrap', body.closest('.table-panel')).classList.toggle('is-hidden', empty);
  }

  function renderCampaigns() {
    const body = $('#campaignsTableBody');
    body.innerHTML = state.campaigns.map((c) => {
      const canAnalyse = c.status === 'draft' || c.status === 'preflight_ready';
      const canApprove = c.status === 'preflight_ready';
      const canCancel = !['completed', 'cancelled'].includes(c.status);
      const actions = [
        canAnalyse ? `<button class="row-action" data-preflight-id="${c.id}" data-preflight-name="${escapeHtml(c.name)}">Analisar</button>` : '',
        canApprove ? `<button class="row-action approve" data-approve-id="${c.id}" data-approve-name="${escapeHtml(c.name)}">Aprovar</button>` : '',
        canCancel && c.status !== 'draft' ? `<button class="row-action cancel" data-cancel-id="${c.id}" data-cancel-name="${escapeHtml(c.name)}">Cancelar</button>` : '',
      ].filter(Boolean).join(' ');
      return `<tr>
        <td><strong>${escapeHtml(c.name)}</strong>${c.objective ? `<br><small class="muted">${escapeHtml(c.objective)}</small>` : ''}</td>
        <td><span class="status-badge ${escapeHtml(campaignStatusClass[c.status] || 'neutral')}">${escapeHtml(campaignStatusLabels[c.status] || c.status)}</span></td>
        <td>${canAnalyse && !c.snapshot_hash ? '<span class="muted">—</span>' : escapeHtml(String(c.eligible_count ?? 0))}</td>
        <td class="campaign-msg">${escapeHtml((c.message_text || '').slice(0, 90))}</td>
        <td>${shortDate(c.created_at)}</td>
        <td style="white-space:nowrap">${actions}</td>
      </tr>`;
    }).join('');
    const empty = !state.campaigns.length;
    $('#campaignsEmpty').classList.toggle('is-hidden', !empty);
    $('.table-wrap', $('#campaignsTableBody').closest('.table-panel')).classList.toggle('is-hidden', empty);
  }

  function renderProducts() {
    const search = $('#productSearch').value.trim().toLowerCase();
    const products = state.products.filter((product) => `${product.name} ${product.sku} ${product.category}`.toLowerCase().includes(search));
    $('#productGrid').innerHTML = products.map((product) => `
      <article class="product-card">
        <div class="product-top"><div class="product-icon">◇</div><span class="status-badge ${product.active ? 'success' : 'neutral'}">${product.active ? 'Ativo' : 'Inativo'}</span></div>
        <h3>${escapeHtml(product.name)}</h3><span class="sku">${escapeHtml(product.sku)} · ${escapeHtml(product.category)}</span>
        <div class="product-price"><span>PREÇO<strong>${money(product.current_price_cents)}</strong></span><span>CUSTO EST.<small>${product.current_estimated_unit_cost_cents == null ? 'Não informado' : money(product.current_estimated_unit_cost_cents)}</small></span></div>
      </article>`).join('');
    $('#productsEmpty').classList.toggle('is-hidden', products.length > 0);
  }

  function navigate(view) {
    if (!viewLabels[view]) return;
    if (state.activeView !== view) $('#preflightPanel').classList.add('is-hidden');
    state.activeView = view;
    $$('.view').forEach((node) => node.classList.remove('is-active'));
    $(`#${view}View`).classList.add('is-active');
    $$('.nav-item').forEach((node) => node.classList.toggle('is-active', node.dataset.view === view));
    $('#pageTitle').textContent = viewLabels[view];
    $('#breadcrumb').textContent = viewLabels[view].toUpperCase();
    $('#sidebar').classList.remove('is-open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openModal(type, detail = {}) {
    const modal = $(`#${type}Modal`);
    if (!modal) return;
    $$('.modal').forEach((node) => node.classList.remove('is-active'));
    modal.classList.add('is-active');
    $('#modalBackdrop').classList.remove('is-hidden');
    document.body.style.overflow = 'hidden';
    if (type === 'consent') {
      $('[name="contactId"]', modal).value = detail.id;
      $('#consentContactName').textContent = detail.name;
    }
    window.setTimeout(() => $('input:not([type="hidden"]), select', modal)?.focus(), 30);
  }

  function closeModal() {
    $('#modalBackdrop').classList.add('is-hidden');
    $$('.modal').forEach((node) => node.classList.remove('is-active'));
    document.body.style.overflow = '';
  }

  async function submitContact(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    const payload = {
      fullName: values.fullName.trim(), origin: values.origin, stage: values.stage,
      ...(values.phone.trim() ? { phone: values.phone.trim() } : {}),
      ...(values.email.trim() ? { email: values.email.trim() } : {}),
      ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
      tags: values.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    };
    setButtonLoading(submit, true);
    try {
      await api('/api/v1/contacts', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      $('[name="origin"]', form).value = 'manual';
      $('[name="stage"]', form).value = 'prospect';
      closeModal();
      await loadData();
      toast('Contato criado com sucesso.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  async function submitProduct(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    const payload = {
      sku: values.sku.trim(), name: values.name.trim(), category: values.category.trim(),
      currentPriceCents: Math.round(Number(values.price) * 100),
      ...(values.cost ? { currentEstimatedUnitCostCents: Math.round(Number(values.cost) * 100) } : {}),
      ...(values.costSource.trim() ? { costSource: values.costSource.trim() } : {}),
    };
    setButtonLoading(submit, true);
    try {
      await api('/api/v1/products', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      closeModal();
      await loadData();
      toast('Produto criado com sucesso.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  async function submitCampaign(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    const splitTrimmed = (str) => (str || '').split(',').map((s) => s.trim()).filter(Boolean);
    const audienceRules = {
      ...(splitTrimmed(values.audienceStages).length ? { stages: splitTrimmed(values.audienceStages) } : {}),
      ...(splitTrimmed(values.audienceOrigins).length ? { origins: splitTrimmed(values.audienceOrigins) } : {}),
      ...(splitTrimmed(values.audienceTags).length ? { tagsAny: splitTrimmed(values.audienceTags) } : {}),
    };
    const payload = {
      name: values.name.trim(), messageText: values.messageText.trim(),
      ...(values.objective?.trim() ? { objective: values.objective.trim() } : {}),
      ...(values.linkUrl?.trim() ? { linkUrl: values.linkUrl.trim() } : {}),
      minIntervalHours: Number(values.minIntervalHours),
      maxNotificationsPer30d: Number(values.maxNotificationsPer30d),
      includeConverted: values.includeConverted === 'on',
      audienceRules,
    };
    setButtonLoading(submit, true, 'Criando...');
    try {
      await api('/api/v1/campaigns', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      $('[name="includeConverted"]', form).checked = true;
      closeModal();
      await loadData();
      toast('Campanha criada com sucesso.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  async function approveCampaign(campaignId, campaignName) {
    if (!confirm(`Aprovar campanha "${campaignName}"?\n\nIsso vai enfileirar os destinatários elegíveis para envio pelo n8n. Esta ação não pode ser desfeita sem cancelar a campanha.`)) return;
    try {
      const result = await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/approve`, { method: 'POST' });
      await loadData();
      toast(`Campanha aprovada — ${result.queued} destinatário${result.queued !== 1 ? 's' : ''} na fila.`);
      $('#preflightPanel').classList.add('is-hidden');
    } catch (err) {
      toast(`Erro ao aprovar: ${err.message}`, 'error');
    }
  }

  async function cancelCampaign(campaignId, campaignName) {
    if (!confirm(`Cancelar campanha "${campaignName}"?\n\nTodos os envios pendentes serão cancelados.`)) return;
    try {
      const result = await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/cancel`, { method: 'POST' });
      await loadData();
      toast(`Campanha cancelada — ${result.cancelled} destinatário${result.cancelled !== 1 ? 's' : ''} removido${result.cancelled !== 1 ? 's' : ''} da fila.`);
      $('#preflightPanel').classList.add('is-hidden');
    } catch (err) {
      toast(`Erro ao cancelar: ${err.message}`, 'error');
    }
  }

  async function runPreflight(campaignId, campaignName) {
    const panel = $('#preflightPanel');
    const content = $('#preflightContent');
    panel.dataset.campaignId = campaignId;
    panel.dataset.campaignName = campaignName;
    $('#preflightCampaignName').textContent = campaignName;
    panel.classList.remove('is-hidden');
    content.innerHTML = '<p class="list-placeholder">Calculando elegibilidade…</p>';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const report = await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/preflight`, { method: 'POST' });
      content.innerHTML = buildPreflightHtml(report);
      bindApproveButton(campaignId, campaignName);
      await loadData();
      toast('Análise concluída.');
    } catch (err) {
      content.innerHTML = `<p class="form-error" style="padding:16px">${escapeHtml(err.message)}</p>`;
    }
  }

  function bindApproveButton(campaignId, campaignName) {
    const btn = $('#approveFromPreflightBtn');
    if (!btn) return;
    btn.onclick = () => approveCampaign(campaignId, campaignName);
  }

  function buildPreflightHtml(report) {
    const money_m = (cents) => cents == null ? '—' : money(cents);
    const bandRow = (data, label) => `
      <tr>
        <td>${label}</td><td>${data.contacts}</td>
        <td>${data.converted}</td>
        <td>${money_m(data.revenue_cents)}</td>
      </tr>`;
    const excludedRows = Object.entries(report.excluded_by_reason || {})
      .map(([k, v]) => `<tr><td>${escapeHtml(exclusionLabels[k] || k)}</td><td>${v}</td></tr>`)
      .join('') || '<tr><td colspan="2" class="muted" style="padding:12px 18px">Nenhuma exclusão</td></tr>';
    const recipientRows = (report.recipients || []).map((r) => `
      <tr>
        <td><strong>${escapeHtml(r.full_name)}</strong></td>
        <td>${escapeHtml(r.phone_e164 || '—')}</td>
        <td>${escapeHtml(stageLabels[r.stage] || r.stage)}</td>
        <td>${r.eligible ? '<span class="permission ok">● Elegível</span>' : '<span class="permission blocked">● Excluído</span>'}</td>
        <td style="font-size:10px;color:var(--muted)">${(r.exclusion_reasons || []).map((k) => escapeHtml(exclusionLabels[k] || k)).join(', ') || '—'}</td>
      </tr>`).join('');
    const b = report.exposure_bands || {};
    return `
      <div class="preflight-metrics">
        <div class="metric-card"><div class="metric-head"><span>AVALIADOS</span></div><strong>${report.totals.evaluated}</strong><p>contatos na base</p></div>
        <div class="metric-card accent"><div class="metric-head"><span>ELEGÍVEIS</span></div><strong>${report.totals.eligible}</strong><p>receberão a campanha</p></div>
        <div class="metric-card"><div class="metric-head"><span>EXCLUÍDOS</span></div><strong>${report.totals.excluded}</strong><p>por algum critério</p></div>
      </div>
      ${report.conversion_data === 'not_configured' ? '<p class="preflight-note">Dados de conversão indisponíveis — sem integração ativa com o FoodApp. A coluna "Convertidos" mostrará zero.</p>' : ''}
      <div class="preflight-grid" style="margin-top:18px">
        <div>
          <p class="eyebrow" style="margin:0 0 8px">MOTIVOS DE EXCLUSÃO</p>
          <div class="table-panel"><table style="min-width:0"><thead><tr><th>Motivo</th><th>Qtd</th></tr></thead><tbody>${excludedRows}</tbody></table></div>
        </div>
        <div>
          <p class="eyebrow" style="margin:0 0 8px">EXPOSIÇÃO PRÉVIA (elegíveis)</p>
          <div class="table-panel"><table style="min-width:0">
            <thead><tr><th>Faixa</th><th>Contatos</th><th>Conv.</th><th>Receita</th></tr></thead>
            <tbody>
              ${b.never_received?.contacts ? bandRow(b.never_received, 'Nunca receberam') : ''}
              ${b.received_once?.contacts ? bandRow(b.received_once, 'Receberam 1×') : ''}
              ${b.received_twice?.contacts ? bandRow(b.received_twice, 'Receberam 2×') : ''}
              ${b.received_more_than_twice?.contacts ? bandRow(b.received_more_than_twice, 'Receberam 3×+') : ''}
              ${b.received_more_than_twice_without_conversion?.contacts ? bandRow(b.received_more_than_twice_without_conversion, '3×+ sem conversão') : ''}
            </tbody>
          </table></div>
        </div>
      </div>
      ${recipientRows ? `
        <p class="eyebrow" style="margin:18px 0 8px">LISTA NOMINAL (${(report.recipients || []).length} contatos)</p>
        <div class="table-panel"><div class="table-wrap"><table>
          <thead><tr><th>Nome</th><th>Telefone</th><th>Etapa</th><th>Status</th><th>Motivos de exclusão</th></tr></thead>
          <tbody>${recipientRows}</tbody>
        </table></div></div>
      ` : ''}
      <p class="muted" style="font-size:10px;margin-top:12px">Gerado em ${new Date(report.snapshot_created_at).toLocaleString('pt-BR')} · hash ${(report.snapshot_hash || '').slice(0, 12)}…</p>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;padding-top:16px;border-top:1px solid var(--line)">
        <p style="flex:1;font-size:11px;color:var(--muted);margin:0;align-self:center">Somente owner ou manager podem aprovar. O envio real requer n8n + Evolution configurados.</p>
        <button class="primary-button" id="approveFromPreflightBtn" style="background:var(--green)">Aprovar e enfileirar →</button>
      </div>
    `;
  }

  async function submitConsent(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const error = $('[data-form-error]', form);
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    const payload = {
      channel: 'whatsapp', purpose: values.purpose, action: values.action,
      source: values.source, policyVersion: '1.0', occurredAt: new Date().toISOString(),
    };
    setButtonLoading(submit, true, 'Registrando...');
    try {
      await api(`/api/v1/contacts/${encodeURIComponent(values.contactId)}/consents`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await loadData();
      toast(values.action === 'granted' ? 'Autorização registrada.' : 'Revogação registrada.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setButtonLoading(submit, false);
    }
  }

  function populateStages() {
    const options = Object.entries(stageLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    $('#stageFilter').insertAdjacentHTML('beforeend', options);
    $('#contactStage').innerHTML = options;
  }

  function bindEvents() {
    $('#loginForm').addEventListener('submit', login);
    $('#logoutButton').addEventListener('click', () => logout());
    $('#refreshButton').addEventListener('click', () => loadData(true));
    $('#menuButton').addEventListener('click', () => $('#sidebar').classList.toggle('is-open'));
    $('#togglePassword').addEventListener('click', () => {
      const input = $('#passwordInput');
      input.type = input.type === 'password' ? 'text' : 'password';
      $('#togglePassword').setAttribute('aria-label', input.type === 'password' ? 'Mostrar senha' : 'Ocultar senha');
    });
    $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
    $$('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.go)));
    $$('[data-open]').forEach((button) => button.addEventListener('click', () => openModal(button.dataset.open)));
    $$('[data-close]').forEach((button) => button.addEventListener('click', closeModal));
    $('#modalBackdrop').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
    $('#contactSearch').addEventListener('input', renderContacts);
    $('#stageFilter').addEventListener('change', renderContacts);
    $('#productSearch').addEventListener('input', renderProducts);
    $('#contactsTableBody').addEventListener('click', (event) => {
      const button = event.target.closest('[data-consent-id]');
      if (button) openModal('consent', { id: button.dataset.consentId, name: button.dataset.consentName });
    });
    $('#campaignsTableBody').addEventListener('click', (event) => {
      const pf = event.target.closest('[data-preflight-id]');
      if (pf) return runPreflight(pf.dataset.preflightId, pf.dataset.preflightName);
      const ap = event.target.closest('[data-approve-id]');
      if (ap) return approveCampaign(ap.dataset.approveId, ap.dataset.approveName);
      const ca = event.target.closest('[data-cancel-id]');
      if (ca) return cancelCampaign(ca.dataset.cancelId, ca.dataset.cancelName);
    });
    $('#closePreflightButton').addEventListener('click', () => $('#preflightPanel').classList.add('is-hidden'));
    $('#contactForm').addEventListener('submit', submitContact);
    $('#productForm').addEventListener('submit', submitProduct);
    $('#consentForm').addEventListener('submit', submitConsent);
    $('#campaignForm').addEventListener('submit', submitCampaign);
  }

  async function init() {
    populateStages();
    bindEvents();
    await checkHealth();
    await restoreSession();
  }

  init();
})();
