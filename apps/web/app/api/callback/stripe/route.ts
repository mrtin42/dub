import { limiter } from "@/lib/cron";
import prisma from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { redis } from "@/lib/upstash";
import { PLANS, getPlanFromPriceId, log } from "@dub/utils";
import { resend, sendEmail } from "emails";
import UpgradeEmail from "emails/upgrade-email";
import { NextResponse } from "next/server";
import Stripe from "stripe";

const relevantEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

// POST /api/callback/stripe – listen to Stripe webhooks
export const POST = async (req: Request) => {
  const buf = await req.text();
  const sig = req.headers.get("Stripe-Signature") as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event: Stripe.Event;
  try {
    if (!sig || !webhookSecret) return;
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err: any) {
    console.log(`❌ Error message: ${err.message}`);
    return new Response(`Webhook Error: ${err.message}`, {
      status: 400,
    });
  }
  if (relevantEvents.has(event.type)) {
    try {
      if (event.type === "checkout.session.completed") {
        const checkoutSession = event.data.object as Stripe.Checkout.Session;

        if (
          checkoutSession.client_reference_id === null ||
          checkoutSession.customer === null
        ) {
          await log({
            message: "Missing items in Stripe webhook callback",
            type: "cron",
            mention: true,
          });
          return;
        }

        const subscription = await stripe.subscriptions.retrieve(
          checkoutSession.subscription as string,
        );
        const priceId = subscription.items.data[0].price.id;

        const plan = getPlanFromPriceId(priceId);

        if (!plan) {
          await log({
            message: "Invalid price ID in checkout.session.completed event",
            type: "cron",
            mention: true,
          });
          return;
        }

        const stripeId = checkoutSession.customer.toString();

        // when the project subscribes to a plan, set their stripe customer ID
        // in the database for easy identification in future webhook events
        // also update the billingCycleStart to today's date

        const project = await prisma.project.update({
          where: {
            id: checkoutSession.client_reference_id,
          },
          data: {
            stripeId,
            billingCycleStart: new Date().getDate(),
            usageLimit: plan.limits.clicks!,
            linksLimit: plan.limits.links!,
            domainsLimit: plan.limits.domains!,
            tagsLimit: plan.limits.tags!,
            usersLimit: plan.limits.users!,
            plan: plan.name.toLowerCase(),
          },
          select: {
            users: {
              select: {
                user: {
                  select: {
                    name: true,
                    email: true,
                  },
                },
              },
            },
          },
        });

        const users = project.users.map(({ user }) => ({
          name: user.name,
          email: user.email,
        }));

        await Promise.allSettled(
          users.map((user) => {
            limiter.schedule(() =>
              sendEmail({
                email: user.email as string,
                subject: `Thank you for upgrading to Dub.co ${plan.name}!`,
                react: UpgradeEmail({
                  name: user.name,
                  email: user.email as string,
                  plan: plan.name,
                }),
                marketing: true,
              }),
            );
          }),
        );
      }

      // for subscription updates
      if (event.type === "customer.subscription.updated") {
        const subscriptionUpdated = event.data.object as Stripe.Subscription;
        const priceId = subscriptionUpdated.items.data[0].price.id;

        const plan = getPlanFromPriceId(priceId);

        if (!plan) {
          await log({
            message: "Invalid price ID in customer.subscription.updated event",
            type: "cron",
            mention: true,
          });
          return;
        }

        const stripeId = subscriptionUpdated.customer.toString();

        const project = await prisma.project.findUnique({
          where: {
            stripeId,
          },
        });

        if (!project) {
          await log({
            message:
              "Project with Stripe ID *`" +
              stripeId +
              "`* not found in Stripe webhook `customer.subscription.updated` callback",
            type: "cron",
          });
          return NextResponse.json({ received: true });
        }

        // If a project upgrades/downgrades their subscription, update their usage limit in the database.
        await prisma.project.update({
          where: {
            stripeId,
          },
          data: {
            usageLimit: plan.limits.clicks!,
            linksLimit: plan.limits.links!,
            domainsLimit: plan.limits.domains!,
            tagsLimit: plan.limits.tags!,
            usersLimit: plan.limits.users!,
            plan: plan.name.toLowerCase(),
          },
          select: {
            users: {
              select: {
                user: {
                  select: {
                    name: true,
                    email: true,
                  },
                },
              },
            },
          },
        });
      }

      // If project cancels their subscription
      if (event.type === "customer.subscription.deleted") {
        const subscriptionDeleted = event.data.object as Stripe.Subscription;

        const stripeId = subscriptionDeleted.customer.toString();

        // If a project deletes their subscription, reset their usage limit in the database to 1000.
        // Also remove the root domain redirect for all their domains from Redis.
        const project = await prisma.project.findUnique({
          where: {
            stripeId,
          },
          select: {
            slug: true,
            domains: true,
            users: {
              select: {
                user: {
                  select: {
                    email: true,
                  },
                },
              },
            },
          },
        });

        if (!project) {
          await log({
            message:
              "Project with Stripe ID *`" +
              stripeId +
              "`* not found in Stripe webhook `customer.subscription.deleted` callback",
            type: "cron",
          });
          return NextResponse.json({ received: true });
        }

        const projectUsers = project.users.map(
          ({ user }) => user.email as string,
        );
        const projectDomains = project.domains.map((domain) => domain.slug);

        const pipeline = redis.pipeline();
        // remove root domain redirect for all domains
        projectDomains.forEach((domain) => {
          pipeline.del(`root:${domain}`);
        });

        const FREE_PLAN = PLANS.find((plan) => plan.name === "free")!;

        await Promise.allSettled([
          prisma.project.update({
            where: {
              stripeId,
            },
            data: {
              plan: "free",
              usageLimit: FREE_PLAN.limits.clicks!,
              linksLimit: FREE_PLAN.limits.links!,
              domainsLimit: FREE_PLAN.limits.domains!,
              tagsLimit: FREE_PLAN.limits.tags!,
              usersLimit: FREE_PLAN.limits.users!,
            },
          }),
          pipeline.exec(),
          log({
            message:
              ":cry: Project *`" +
              project.slug +
              "`* deleted their subscription",
            type: "cron",
            mention: true,
          }),
          resend.emails.send({
            from: "Steven from Dub.co <steven@dub.co>",
            to: projectUsers,
            subject: "Feedback on your Dub.co experience?",
            text: "Hey!\n\nI noticed you recently cancelled your Dub.co subscription – we're sorry to see you go!\n\nI'd love to hear your feedback on your experience with Dub – what could we have done better?\n\nThanks!\n\nSteven Tey\nFounder, Dub.co",
          }),
        ]);
      }
    } catch (error) {
      await log({
        message: `Stripe webook failed. Error: ${error.message}`,
        type: "cron",
        mention: true,
      });
      return new Response(
        'Webhook error: "Webhook handler failed. View logs."',
        {
          status: 400,
        },
      );
    }
  } else {
    return new Response(`🤷‍♀️ Unhandled event type: ${event.type}`, {
      status: 400,
    });
  }

  return NextResponse.json({ received: true });
};
