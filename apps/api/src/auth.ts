import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { resendResetDelivery } from './reset-mail';
import {consumeAuthLimit} from './auth-request-limit';

export type ResetDelivery = (message: { email: string; url: string }) => Promise<void>;

export function createAuth(env: Env, deliverReset?: ResetDelivery,subject?:{key:string;window:number;max:number}) {
  return betterAuth({
    database: env.DB,
    baseURL: env.AUTH_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.AUTH_BASE_URL],
    advanced:{ipAddress:{ipAddressHeaders:['cf-connecting-ip']}},
    rateLimit:{
      enabled:true,window:60,max:100,
      customRules:{
        '/sign-in/email':{window:60,max:100},
        '/request-password-reset':{window:3600,max:20},
        '/reset-password':{window:60,max:20},
        '/change-password':{window:60,max:20},
        '/get-session':false,'/sign-out':false,
      },
      customStorage:{consume:async(key,rule)=>{
        const ip=await consumeAuthLimit(env.DB,env.BETTER_AUTH_SECRET,'ip:'+key,rule);
        // Check IP first: changing the email cannot create unbounded subject
        // counters after this client's bucket is already exhausted.
        if(!ip.allowed||!subject)return ip;
        return consumeAuthLimit(env.DB,env.BETTER_AUTH_SECRET,subject.key,subject);
      }},
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 900,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        // Tests inject a private mailbox; real delivery is explicitly configured.
        await (deliverReset ?? resendResetDelivery(env))({ email: user.email, url });
      },
      onPasswordReset: async ({ user }) => {
        await env.DB.prepare('UPDATE access_state SET must_change_password = 0 WHERE user_id = ?')
          .bind(user.id).run();
      },
    },
    session: { cookieCache: { enabled: false } },
    plugins: [admin()],
  });
}
