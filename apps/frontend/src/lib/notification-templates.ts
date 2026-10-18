import { ORBIT_API_URL, merchantRequestHeaders } from './api';
export { PREVIEW_VARIABLES, renderSafeMarkdown } from './template-markdown';
export type TemplateType='payment_receipt'|'subscription_activated'|'payment_failed'|'subscription_cancelled';
export interface NotificationTemplate { type:TemplateType; subject:string; markdown:string; updated_at?:string }
async function json<T>(path:string,init?:RequestInit):Promise<T>{const response=await fetch(new URL(path,ORBIT_API_URL),{...init,headers:{...merchantRequestHeaders(),...init?.headers}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'Request failed');return body;}
export async function fetchNotificationTemplates(){return json<{templates:NotificationTemplate[];variables:string[]}>('/notification-templates');}
export async function saveNotificationTemplate(template:NotificationTemplate){return json<{template:NotificationTemplate}>(`/notification-templates/${template.type}`,{method:'PUT',body:JSON.stringify({subject:template.subject,markdown:template.markdown})});}
export async function sendTemplateTest(type:TemplateType){return json<{message:string;recipient:string}>(`/notification-templates/${type}/test`,{method:'POST'});}
