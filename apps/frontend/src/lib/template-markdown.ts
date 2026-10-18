export const PREVIEW_VARIABLES:Record<string,string>={customer_wallet:'GDX7…C4QZ',amount:'29.00 USDC',tx_hash:'8a4f…0c12',portal_link:'https://app.orbit.example/portal'};
export function renderSafeMarkdown(source:string,variables:Record<string,string>=PREVIEW_VARIABLES):string {
  const escaped=source.replace(/\{\{([a-z_]+)\}\}/g,(_,key)=>variables[key]??`{{${key}}}`).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] as string));
  return escaped.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" rel="noopener noreferrer">$1</a>').replace(/\n/g,'<br>');
}
