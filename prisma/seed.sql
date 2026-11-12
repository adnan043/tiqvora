-- prisma/seed.sql: made-up sample data. Never for a live database.
-- Where it is loaded: a review copy and a public preview of this site, the staging database
-- when the owner presses "Load sample data" (never their live one), and your own machine with
-- `npm run db:seed`. No users: people sign up. Safe to run twice, all or nothing.
--
-- A help center for "Northwind Coffee Co.", a fictional coffee roaster: categories, articles
-- (published, drafts, one archived), snippets, and the search chunks of every published article
-- and snippet, so search and the help center work straight after loading. Ids come from
-- subselects on the unique slugs, never hard-coded.
BEGIN;

-- Stop when real data is there: this knowledge base is already in use.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "kb_articles" WHERE "slug" NOT IN ('how-long-does-shipping-take', 'tracking-your-order', 'changing-or-cancelling-an-order', 'damaged-or-missing-items', 'international-shipping', 'how-coffee-subscriptions-work', 'pause-skip-or-change-delivery-date', 'change-coffee-or-grind-in-subscription', 'cancel-your-subscription', 'subscription-gift-options', 'pour-over-brewing-guide', 'french-press-brewing-guide', 'espresso-dial-in-basics', 'cold-brew-at-home', 'storing-coffee-beans-fresh', 'choosing-the-right-grind-size', 'cleaning-your-burr-grinder', 'grinder-not-grinding-troubleshooting', 'equipment-warranty', 'descaling-your-espresso-machine', 'update-payment-method', 'why-was-i-charged', 'refund-policy', 'reset-your-password', 'apply-a-discount-code', 'holiday-shipping-cutoffs', 'wholesale-accounts', 'loyalty-beans-program'))
     OR EXISTS (SELECT 1 FROM "kb_categories" WHERE "slug" NOT IN ('orders-shipping', 'subscriptions', 'brewing-guides', 'equipment-grinders', 'account-billing'))
     OR EXISTS (SELECT 1 FROM "kb_snippets" WHERE "question" NOT IN ('What are your customer support hours?', 'Do you sell decaf coffee?', 'Are your coffee bags recyclable or compostable?', 'How do I read the roast date on the bag?', 'What is the minimum order for free shipping?', 'Do you sell gift cards?', 'How much caffeine is in a cup of your coffee?', 'Can I pick up my order from the roastery?', 'Which payment methods do you accept?', 'Is your coffee organic and fairly traded?')) THEN
    RAISE EXCEPTION 'prisma/seed.sql is sample data and this knowledge base is already in use. Nothing was changed.';
  END IF;
END $$;

-- The help center's words (the row is created by the migration).
UPDATE "helpdesk_settings" SET
  "assistant_name" = 'Bean',
  "greeting" = 'Hi! I’m Bean, Northwind’s assistant. Ask me about orders, subscriptions or brewing.',
  "launcher_label" = 'Help',
  "business_hours" = 'Mon–Fri, 9 am–5 pm Eastern',
  "help_title" = 'How can we help?',
  "help_intro" = 'Guides for your Northwind Coffee orders, subscriptions, brewing and equipment. Search, or ask our assistant.',
  "updated_at" = now()
WHERE "id" = 1;

-- Categories. Unique slugs and ON CONFLICT DO NOTHING: safe to run twice.
INSERT INTO "kb_categories" ("slug", "name", "description", "icon", "position", "updated_at") VALUES
  ('orders-shipping', 'Orders & shipping', 'Delivery times, tracking, changing an order and what to do when something arrives damaged.', 'globe', 0, now()),
  ('subscriptions', 'Subscriptions', 'How coffee subscriptions work: pausing, skipping, switching coffees and cancelling.', 'refresh', 1, now()),
  ('brewing-guides', 'Brewing guides', 'Step-by-step recipes for pour-over, French press, espresso and cold brew.', 'file', 2, now()),
  ('equipment-grinders', 'Equipment & grinders', 'Grind sizes, cleaning, troubleshooting and warranty for grinders and brewers.', 'zap', 3, now()),
  ('account-billing', 'Account & billing', 'Payment methods, charges, refunds, discount codes and signing in.', 'user', 4, now())
ON CONFLICT ("slug") DO NOTHING;

-- Articles. created_by / updated_by 0: no user (the seed makes none).
INSERT INTO "kb_articles" ("category_id", "slug", "title", "excerpt", "body", "status", "published_at", "last_reviewed_at",
  "view_count", "helpful_count", "not_helpful_count", "created_by", "updated_by", "created_at", "updated_at")
SELECT c."id", v."slug", v."title", v."excerpt", v."body", v."status", v."published_at", v."reviewed_at",
  v."views", v."helpful", v."not_helpful", 0, 0, v."reviewed_at", v."reviewed_at"
FROM (VALUES
  ('orders-shipping', 'how-long-does-shipping-take', 'How long does shipping take?', 'We roast to order and ship within two business days. Standard delivery takes 3–5 business days; express takes 1–2.',
   'We roast every order fresh, so your coffee leaves our roastery within **two business days** of the order. Orders placed before 11 am (Eastern) on a weekday usually ship the next business day.

## Delivery options

| Option | Delivery time after shipping | Price |
| --- | --- | --- |
| Standard | 3–5 business days | Free on orders of $35 or more, otherwise $5.95 |
| Express | 1–2 business days | $12.95 |
| Local pickup | Ready the next business day | Free |

## Why does my order take a day to ship?

We don''t keep roasted coffee on a shelf. Each bag is roasted, rested for a few hours so it can release carbon dioxide, then sealed in a valve bag. That short wait is what makes the coffee taste fresh when it arrives.

## Holidays and busy weeks

Around public holidays and during our seasonal sales, roasting can take an extra day. We post any delays on the checkout page before you pay, so you always know what to expect.

## Still waiting?

If your order hasn''t arrived within the time above, check your tracking link first (see [Tracking your order](/help/articles/tracking-your-order/)). If tracking hasn''t moved for three business days, contact us and we''ll chase the carrier for you.',
   'published', now() - interval '120 days', now() - interval '120 days', 1840, 212, 14),
  ('orders-shipping', 'tracking-your-order', 'Tracking your order', 'Find your tracking number in the shipping email or in your account, and what each tracking status means.',
   'As soon as your coffee leaves the roastery we send a **shipping confirmation email** with a tracking link.

## Where to find your tracking number

1. Open the email with the subject "Your Northwind order is on its way".
2. Select **Track my package**.
3. Or sign in, open **Account › Orders**, and select the order: the tracking number is under the delivery address.

## What the statuses mean

- **Label created**: the label is printed and the box is waiting for the carrier''s daily pickup. This can show for up to 24 hours.
- **In transit**: the carrier has the parcel and it''s moving between depots.
- **Out for delivery**: it should arrive today.
- **Delivered**: the carrier scanned it at your address or a safe place.

## Tracking says delivered, but I can''t find it

Check around your door, with neighbours and in your building''s mail room. Carriers sometimes mark a parcel delivered a few hours early. If it still hasn''t turned up by the next day, contact us with your order number and we''ll open a claim with the carrier.

## No tracking email?

Look in your spam or promotions folder. Subscription orders use the same email address as your account, so make sure it''s up to date in **Account › Profile**.',
   'published', now() - interval '118 days', now() - interval '118 days', 1525, 168, 19),
  ('orders-shipping', 'changing-or-cancelling-an-order', 'Changing or cancelling an order', 'You can change the grind, address or items of an order until it is roasted. Here is how, and what happens after that.',
   'Because we roast to order, there is a short window in which you can change or cancel an order.

## Before roasting starts

Until your order shows **Roasting** in **Account › Orders**, you can:

- change the grind size or swap a coffee for another of the same size,
- update the delivery address,
- add items (we''ll charge the difference),
- cancel the whole order for a full refund.

Select the order and choose **Edit order**. Changes are saved immediately and you''ll get an updated confirmation email.

## After roasting starts

Once the status is **Roasting** or **Shipped**, the coffee has been made for you and we can''t change it. You can still:

- ask the carrier to redirect the parcel using the tracking link, or
- return unopened equipment within 30 days (see [Refund policy](/help/articles/refund-policy/)).

Roasted coffee can''t be returned for hygiene reasons, but if something is wrong with it, tell us and we''ll make it right.

## Wrong address on a shipped order?

Contact us as soon as possible with your order number and the correct address. If the carrier hasn''t picked it up yet we can often fix the label.',
   'published', now() - interval '115 days', now() - interval '115 days', 980, 101, 12),
  ('orders-shipping', 'damaged-or-missing-items', 'Damaged or missing items', 'A bag arrived split, a grinder is broken or something is missing from the box? Report it within 14 days and we will replace it.',
   'We pack every box carefully, but occasionally something goes wrong on the way. If an item arrives damaged or is missing, we''ll replace it at no cost.

## Report it within 14 days

1. Take a photo of the damaged item and the outside of the box.
2. Contact us with your order number, what''s wrong and the photos.
3. We''ll send a replacement, usually within two business days. You don''t need to return the damaged item.

## Missing items

Some orders ship in more than one box, especially when equipment and coffee are ordered together. Check your shipping email: if it lists two tracking numbers, the second box may still be on its way.

If everything has arrived and an item is still missing, let us know and we''ll send it right away.

## Coffee that tastes off

If a bag tastes stale, sour or burnt, tell us which coffee it was and the roast date printed on the bag. We''ll send a fresh bag or a different coffee you''d rather try.',
   'published', now() - interval '110 days', now() - interval '110 days', 642, 77, 6),
  ('orders-shipping', 'international-shipping', 'Do you ship internationally?', 'We ship to the US and Canada. Here is what to expect for Canadian orders, including customs and delivery times.',
   'We currently ship to addresses in the **United States** and **Canada**.

## Canada

- Delivery takes 5–8 business days after shipping.
- Shipping is a flat $14.95, free on orders of $75 or more.
- Prices are charged in US dollars. Your bank converts them at its own rate.
- We pay the duties and import taxes, so there is nothing to pay when the parcel arrives.

## Other countries

We don''t ship elsewhere yet. Many customers abroad send our coffee as a gift to friends in the US instead.

## Equipment outside the US

Grinders and brewers are sold with US plugs (120 V). If you order electrical equipment for a Canadian address, it works as is: Canada uses the same voltage and plug.',
   'published', now() - interval '95 days', now() - interval '95 days', 455, 38, 9),
  ('subscriptions', 'how-coffee-subscriptions-work', 'How coffee subscriptions work', 'Pick a coffee, a grind and how often. We roast and ship it on your schedule, and you can change anything at any time.',
   'A Northwind subscription sends freshly roasted coffee on a schedule you choose. There''s no minimum term, and you can change or cancel it whenever you like.

## Setting one up

1. Choose a coffee, or **Roaster''s choice** to get a different single origin each time.
2. Choose a bag size (250 g or 1 kg) and a grind (whole bean, or a grind for your brewer).
3. Choose how often: every 1, 2, 3 or 4 weeks.

## When you''re charged

You''re charged on the day each order is roasted, never in advance. The date of your next order is always shown in **Account › Subscriptions**, and we email you three days before so you have time to make changes.

## Subscriber perks

- 10% off every subscription bag.
- Free standard shipping on every delivery.
- Early access to limited coffees.

## Managing it

Everything is in **Account › Subscriptions**: [pause or skip a delivery](/help/articles/pause-skip-or-change-delivery-date/), [switch coffee or grind](/help/articles/change-coffee-or-grind-in-subscription/), update the address or payment method, or [cancel](/help/articles/cancel-your-subscription/).',
   'published', now() - interval '130 days', now() - interval '130 days', 1312, 154, 11),
  ('subscriptions', 'pause-skip-or-change-delivery-date', 'Pause, skip or change a delivery date', 'Going away or still have coffee? Skip one delivery, move the date or pause your subscription for up to three months.',
   'Have too much coffee, or going on holiday? You can adjust your subscription without cancelling it.

## Skip the next delivery

1. Sign in and open **Account › Subscriptions**.
2. Select **Skip next delivery**.

The following delivery moves out by one interval. You won''t be charged for the skipped one.

## Move the date

Select **Change date** and pick any day in the next 60 days. Future deliveries then follow your usual interval from the new date.

## Pause

Select **Pause** and choose 2 weeks, 1 month, 2 months or 3 months. We''ll email you a week before it starts again. You can resume early at any time with **Resume now**.

## Deadlines

Changes must be made **before 11 am (Eastern) the day before** your order is roasted. After that, the order is already in the roasting queue and will ship as planned.',
   'published', now() - interval '128 days', now() - interval '128 days', 1104, 139, 8),
  ('subscriptions', 'change-coffee-or-grind-in-subscription', 'Change the coffee or grind in your subscription', 'Switch to another coffee, change bag size or grind, or add a second coffee to your subscription.',
   'You can change what''s in your subscription at any time. Changes apply from the next order that hasn''t started roasting.

## Switch coffee

1. Open **Account › Subscriptions** and select **Edit**.
2. Under **Coffee**, choose a new one. Prices update straight away.
3. Select **Save**.

Not sure what to pick? **Roaster''s choice** rotates through our current single origins so you get something new every delivery.

## Change the grind

Choose whole bean if you have a grinder: it keeps the coffee fresh for longer. Otherwise pick the grind that matches your brewer:

- **Espresso**: fine, like table salt.
- **Pour-over / filter**: medium, like sand.
- **French press / cold brew**: coarse, like sea salt.

See [Choosing the right grind size](/help/articles/choosing-the-right-grind-size/) for more detail.

## Add a second coffee

Select **Add a coffee** to include another bag in the same delivery. Both bags ship together and share free shipping.',
   'published', now() - interval '126 days', now() - interval '126 days', 734, 82, 5),
  ('subscriptions', 'cancel-your-subscription', 'Cancel your subscription', 'Cancel any time from your account, with no fees. Orders already roasting will still ship.',
   'You can cancel your subscription at any time, with no cancellation fee.

## How to cancel

1. Sign in and open **Account › Subscriptions**.
2. Select **Cancel subscription**.
3. Tell us why, if you''d like (it''s optional and helps us improve), then confirm.

You''ll get an email confirming the cancellation.

## What happens to an upcoming order?

- If the next order **hasn''t started roasting**, it''s cancelled and you won''t be charged.
- If it''s **already roasting or shipped**, it will still arrive and is charged as usual.

## Would a pause work instead?

If you just have too much coffee or are travelling, you can [pause for up to three months](/help/articles/pause-skip-or-change-delivery-date/) and keep your subscriber discount.

## Restarting later

Cancelled subscriptions stay in your account. Select **Restart** at any time to pick up where you left off with the same coffee and settings.',
   'published', now() - interval '124 days', now() - interval '124 days', 690, 64, 13),
  ('subscriptions', 'subscription-gift-options', 'Giving a coffee subscription as a gift', 'Prepaid gift subscriptions for 3, 6 or 12 months, with a personal message and a start date of your choice.',
   'A gift subscription is a prepaid run of deliveries for someone else. It ends on its own, so the recipient never has to cancel anything.

## Choosing a gift

- **Length**: 3, 6 or 12 deliveries.
- **Frequency**: every 2 or 4 weeks.
- **Coffee**: Roaster''s choice, or one coffee for every delivery.
- **Grind**: whole bean is the safest choice if you don''t know their brewer.

## Personal message and start date

Add a message at checkout: we print it on a card in the first box. Pick any start date in the next six months, which is handy for birthdays and holidays.

## Can the recipient change it?

Yes. The recipient gets an email with a link to claim the gift, then can change the grind, delivery address and dates. They can''t see what you paid.

## After the last delivery

We email the recipient to let them know it has ended and offer them a regular subscription. Nothing renews automatically, and you''re never charged again.',
   'published', now() - interval '60 days', now() - interval '60 days', 388, 41, 3),
  ('brewing-guides', 'pour-over-brewing-guide', 'Pour-over brewing guide', 'A simple, repeatable pour-over recipe: 15 g of coffee, 250 g of water at 94 °C, ready in about three minutes.',
   'Pour-over gives a clean, bright cup that shows off a coffee''s origin. This recipe works with most cone drippers.

## What you need

- 15 g of coffee, ground medium (like sand)
- 250 g of water just off the boil, about 94 °C
- A cone dripper, a paper filter, a scale and a kettle

## Recipe

1. **Rinse the filter** with hot water and pour that water away. This removes paper taste and warms the dripper.
2. **Add the coffee** and shake it level.
3. **Bloom**: start a timer and pour 40 g of water, just enough to wet all the grounds. Wait 30 seconds.
4. **Pour slowly** in small circles to 150 g by 1:00.
5. **Finish** pouring to 250 g by 1:45.
6. Let it drain. Total time should be **2:45 to 3:30**.

## Adjusting the taste

- **Sour or thin, drains too fast**: grind finer.
- **Bitter or dry, drains too slowly**: grind coarser.
- **Too strong or too weak**: change the coffee by 1 g, not the water.

Change one thing at a time and write down what you did. That''s the fastest way to your perfect cup.',
   'published', now() - interval '150 days', now() - interval '150 days', 2104, 287, 16),
  ('brewing-guides', 'french-press-brewing-guide', 'French press brewing guide', 'A full-bodied French press in four minutes: coarse grind, 1:15 ratio and a gentle plunge.',
   'The French press makes a rich, full-bodied cup and needs no filters. It''s very forgiving, which makes it a great place to start.

## What you need

- 30 g of coffee, ground coarse (like sea salt)
- 450 g of water at about 94 °C
- A French press, a spoon and a timer

## Recipe

1. Warm the press with hot water, then pour it out.
2. Add the coffee and start a timer.
3. Pour all 450 g of water, making sure every ground is wet.
4. At **4:00**, stir the crust on top gently and scoop off the foam.
5. Put the lid on and press the plunger down slowly, about 20 seconds.
6. **Pour it all out straight away.** Coffee left on the grounds keeps brewing and turns bitter.

## Less sludge in the cup

- Use a coarser grind: fine particles pass through the mesh.
- Wait five minutes after step 4 before pressing so fines settle.
- Don''t push the plunger all the way to the bottom.

## Cleaning

Take the plunger apart once a week and wash the mesh with warm soapy water. Old coffee oils trapped in the mesh make every cup taste stale.',
   'published', now() - interval '148 days', now() - interval '148 days', 1650, 198, 10),
  ('brewing-guides', 'espresso-dial-in-basics', 'Dialling in espresso', 'Start with 18 g in, 36 g out in 25–30 seconds, then adjust the grind by taste.',
   '"Dialling in" means adjusting your grinder until a coffee tastes its best as espresso. Every new bag needs a few shots to get there.

## Starting recipe

- **Dose**: 18 g of finely ground coffee in a double basket
- **Yield**: 36 g of espresso in the cup (a 1:2 ratio)
- **Time**: 25 to 30 seconds from pressing the button

Weigh both the dose and the yield. Guessing by volume is the most common reason espresso tastes different every day.

## Adjust the grind, one step at a time

- **Runs too fast (under 25 s), tastes sour or salty**: grind finer.
- **Runs too slow (over 32 s), tastes bitter or harsh**: grind coarser.
- **Tastes good but too intense**: increase the yield to 40 g.

## Good habits

1. Distribute the grounds evenly before tamping.
2. Tamp level and firmly; the exact pressure matters less than being consistent.
3. Flush the group head for two seconds before each shot.
4. Use beans 7 to 28 days after the roast date. Very fresh beans can spurt and taste sharp.

Our espresso blends list a suggested recipe on the bag. Use that as your starting point.',
   'published', now() - interval '140 days', now() - interval '140 days', 1420, 160, 22),
  ('brewing-guides', 'cold-brew-at-home', 'Making cold brew at home', 'Steep coarse coffee in cold water for 16–18 hours for a smooth concentrate that keeps for a week.',
   'Cold brew is smooth, low in acidity and easy to make in a jar. It''s brewed as a concentrate, so a batch lasts all week.

## What you need

- 100 g of coffee, ground coarse
- 1 litre of cold, filtered water
- A large jar, and a paper filter or fine cloth

## Recipe

1. Put the coffee in the jar, add the water and stir until all the grounds are wet.
2. Cover and leave it in the fridge for **16 to 18 hours**.
3. Strain through the filter. Take your time: squeezing the grounds makes it bitter.
4. Keep the concentrate in a sealed bottle in the fridge for up to **7 days**.

## Serving

Mix one part concentrate with one part water or milk, over ice. Adjust to taste: some people like it stronger.

## Which coffee?

Chocolatey, nutty coffees such as our **Harbor Blend** make a classic cold brew. Fruity single origins work too and taste like iced tea with a coffee finish.',
   'published', now() - interval '90 days', now() - interval '90 days', 1188, 133, 7),
  ('brewing-guides', 'storing-coffee-beans-fresh', 'How to keep your coffee fresh', 'Keep beans in their resealed bag, away from light and heat, and use them within a month of roasting.',
   'Coffee is at its best between about **one and four weeks** after its roast date, printed on every bag.

## Store it well

- **Keep it in our bag.** The one-way valve lets gas out without letting air in. Squeeze out the air and close the zip after each use.
- **Cool, dark and dry.** A cupboard away from the stove is ideal.
- **Not in the fridge.** Beans absorb moisture and smells from other food.

## Freezing

If you bought more than you''ll use in a month, freeze it in small airtight portions, one week''s worth each. Take out one portion at a time and let it reach room temperature **before opening** so no condensation forms. Never refreeze.

## Whole bean or ground?

Ground coffee goes stale in days, whole beans in weeks. If you don''t have a grinder yet, order smaller bags more often, which a [subscription](/help/articles/how-coffee-subscriptions-work/) makes easy.',
   'published', now() - interval '85 days', now() - interval '85 days', 980, 120, 4),
  ('equipment-grinders', 'choosing-the-right-grind-size', 'Choosing the right grind size', 'A grind size chart for every brewer, from espresso to cold brew, and how to tell if yours is off.',
   'Grind size controls how fast water extracts flavour from coffee. Finer grinds extract faster; coarser grinds extract slower. Match the grind to your brewer.

## Grind size chart

| Brewer | Grind | Looks like | Setting on the Northwind Burr Grinder |
| --- | --- | --- | --- |
| Espresso | Fine | Table salt | 2–6 |
| Moka pot | Medium-fine | Fine sand | 8–10 |
| Pour-over, drip | Medium | Sand | 12–18 |
| French press | Coarse | Sea salt | 24–28 |
| Cold brew | Extra coarse | Cracked pepper | 30–32 |

## Signs the grind is wrong

- **Sour, thin, watery**: too coarse. Go finer.
- **Bitter, dry, harsh**: too fine. Go coarser.
- **Muddy cup or clogged filter**: too fine, or a grinder making lots of dust.

## Burr or blade?

A burr grinder crushes coffee to an even size, so every particle brews at the same rate. A blade grinder chops unevenly and makes both dust and boulders, which taste bitter and sour at once. If you can, choose burrs.',
   'published', now() - interval '145 days', now() - interval '145 days', 1730, 201, 12),
  ('equipment-grinders', 'cleaning-your-burr-grinder', 'Cleaning your burr grinder', 'Brush the burrs every two weeks and deep clean every three months to keep your grinder consistent.',
   'Coffee oils and fine particles build up inside every grinder. Over time they go stale and change the grind size. A quick clean keeps your coffee tasting right.

## Every two weeks: quick clean

1. **Unplug the grinder** and empty the hopper.
2. Run it empty for a few seconds to clear the chute.
3. Brush the chute and the outlet with the brush supplied.

## Every three months: deep clean

1. Unplug the grinder and empty the hopper.
2. Turn the upper burr anticlockwise past the coarsest setting and lift it out.
3. Brush both burrs and the chamber. Use a vacuum for loose grounds.
4. Wipe the hopper with a damp cloth and let it dry completely.
5. Put the upper burr back and turn it to your usual setting.

## What not to do

- **Never wash the burrs with water.** They can rust.
- Don''t grind rice to clean it: it can damage the motor and voids the warranty.
- Grinder cleaning tablets are fine; follow the instructions on the pack.

After a deep clean, the first dose may taste a little different. Grind and discard about 10 g of coffee before your first brew.',
   'published', now() - interval '100 days', now() - interval '100 days', 820, 97, 6),
  ('equipment-grinders', 'grinder-not-grinding-troubleshooting', 'My grinder stopped grinding', 'The motor runs but nothing comes out, or it won’t start at all: quick checks before you contact us.',
   'Most grinder problems are caused by a blockage or a safety switch. Try these checks first. **Unplug the grinder before you touch the burrs.**

## The motor doesn''t start

- Check the hopper is clicked fully into place. The grinder has a safety switch and won''t run without it.
- Check the grounds bin is pushed all the way in.
- Try another outlet.
- If it ran for a long time, the motor may have overheated. Leave it for 30 minutes and try again.

## The motor runs but no coffee comes out

1. Empty the hopper.
2. Remove the upper burr (see [Cleaning your burr grinder](/help/articles/cleaning-your-burr-grinder/)).
3. Look for a stuck bean, a stone or packed grounds in the chute, and brush it clear.
4. Reassemble and try again with a small amount of coffee.

Very fine espresso settings with oily, dark-roast beans can pack the chute. Grind a little coarser or clean more often.

## Loud grinding or squealing

Stop using it straight away: a stone may have reached the burrs. Contact us with your order number. This is covered by the [warranty](/help/articles/equipment-warranty/).',
   'published', now() - interval '98 days', now() - interval '98 days', 760, 71, 18),
  ('equipment-grinders', 'equipment-warranty', 'Equipment warranty', 'Grinders and brewers from Northwind have a two-year warranty against manufacturing faults.',
   'All grinders, kettles and brewers bought from Northwind Coffee Co. come with a **two-year warranty** from the delivery date.

## What''s covered

- Faults in materials or manufacturing.
- Motors, switches and electronics that stop working with normal home use.
- Burrs damaged by a stone found in our coffee.

## What isn''t covered

- Wear parts such as burrs after normal use, gaskets and filters.
- Damage from dropping, water, or grinding things other than coffee.
- Commercial use.

## Making a claim

1. Contact us with your order number, a short description and, if you can, a photo or short video of the problem.
2. We''ll try to fix it with you first: many issues are solved in a few minutes.
3. If it can''t be fixed, we''ll send a prepaid return label and ship a repaired or replacement unit, usually within five business days of receiving it.

You don''t need to register your equipment. Your order is your proof of purchase. Bought it as a gift? Ask the person who ordered it for the order number, or contact us with their name and the delivery address.',
   'published', now() - interval '135 days', now() - interval '135 days', 540, 49, 7),
  ('equipment-grinders', 'descaling-your-espresso-machine', 'Descaling your espresso machine or kettle', 'Limescale slows heating and changes the taste. Descale every one to three months depending on your water.',
   'Minerals in tap water slowly build up as limescale inside kettles and espresso machines. It makes heating slower and less accurate and can make coffee taste flat.

## How often

- **Hard water** (white marks on taps and glasses): every month.
- **Medium water**: every two months.
- **Soft or filtered water**: every three months.

## Descaling an espresso machine

1. Empty the water tank and fill it with descaling solution mixed as the pack says.
2. Run half the tank through the steam wand and half through the group head, with a jug underneath.
3. Leave it to stand for 15 minutes.
4. Rinse the tank, fill it with fresh water and run a full tank through both again.

## Descaling a kettle

Fill it with a mix of one part white vinegar or citric acid solution and three parts water, boil, leave for an hour, then rinse and boil fresh water twice.

## Prevent it

Using filtered water reduces scale a lot and usually makes better coffee too. Avoid distilled water in espresso machines: some minerals are needed for the sensors and for flavour.',
   'published', now() - interval '70 days', now() - interval '70 days', 610, 66, 4),
  ('account-billing', 'update-payment-method', 'Update your payment method', 'Change the card used for your orders and subscriptions, and what happens if a payment fails.',
   'Your saved card is used for subscription orders and for one-click checkout.

## Change your card

1. Sign in and open **Account › Billing**.
2. Select **Update card** and enter the new details.
3. Select **Save**. The new card is used from your next charge.

We never see or store your full card number: it''s held securely by our payment provider.

## Which payment methods do you accept?

Visa, Mastercard, American Express and Discover, plus Apple Pay and Google Pay at checkout.

## If a payment fails

If a subscription payment is declined, we email you and try again after **two days** and after **five days**. Your order waits until the payment goes through, so the coffee is still roasted fresh. After three failed attempts we pause the subscription; update your card and select **Resume** to restart it.

Common reasons for a decline are an expired card, a new card number after a replacement, or your bank blocking an unusual charge.',
   'published', now() - interval '132 days', now() - interval '132 days', 870, 92, 9),
  ('account-billing', 'why-was-i-charged', 'Why was I charged?', 'Understanding the charges on your statement: subscription orders, authorisation holds and split shipments.',
   'If you see a charge you don''t recognise, it is usually one of the following.

## Your subscription

Subscription orders are charged on the day they''re roasted. Check **Account › Subscriptions** for the date of the last order. The charge shows on your statement as **NORTHWIND COFFEE**.

## A temporary hold

When you place an order, your bank may show a pending **authorisation** for the amount. If you change or cancel the order before roasting, the hold disappears within 3–7 business days, depending on your bank. It is not a second charge.

## Split shipments

If part of an order shipped separately, you may see two charges that add up to the order total.

## Taxes and shipping

Sales tax depends on your delivery address and is added at checkout. Orders under $35 include $5.95 standard shipping.

## Still not sure?

Contact us with the date and amount from your statement (never your full card number) and we''ll look it up. If we charged you by mistake, we''ll refund it in full.',
   'published', now() - interval '112 days', now() - interval '112 days', 760, 58, 21),
  ('account-billing', 'refund-policy', 'Refund policy', 'Equipment can be returned unused within 30 days. Coffee is replaced or refunded when something is wrong with it.',
   'We want you to love what you order. Here''s how refunds work.

## Coffee

Roasted coffee can''t be returned once it has shipped. If a bag is damaged, missing or not as described, we''ll **replace it or refund it**, whichever you prefer. Contact us within 14 days of delivery.

## Equipment

- Unused equipment in its original packaging can be returned within **30 days** of delivery for a full refund.
- We send a prepaid return label for faulty items. For change-of-mind returns, return shipping is $7.95, deducted from the refund.
- Faults after 30 days are covered by the [two-year warranty](/help/articles/equipment-warranty/).

## Cancelled orders

Orders cancelled before roasting are refunded in full straight away.

## How long refunds take

We issue refunds within two business days of approving them. Your bank then takes **3–10 business days** to show it on your statement. Refunds always go back to the original payment method.',
   'published', now() - interval '140 days', now() - interval '140 days', 1010, 88, 17),
  ('account-billing', 'reset-your-password', 'Reset your password', 'Forgot your password? Request a reset link from the sign-in page. It is valid for one hour.',
   'If you can''t remember your password, you can set a new one in a couple of minutes.

## Reset it

1. Go to the sign-in page and select **Forgot password?**
2. Enter the email address on your account.
3. Open the email from us and select the link. It works for **one hour**.
4. Choose a new password.

For your security, we never send passwords by email, and our support team will never ask you for yours.

## Didn''t get the email?

- Check your spam or promotions folder.
- Make sure you used the address you signed up with. Gift recipients use the address the gift was sent to.
- Wait a few minutes and try again: requests are limited to protect your account.

## Signed in with an old email?

If you no longer have access to that inbox, contact us from your new address with an order number and the delivery postcode, and we''ll help you move your account.',
   'published', now() - interval '125 days', now() - interval '125 days', 590, 61, 5),
  ('account-billing', 'apply-a-discount-code', 'Using a discount or gift code', 'Enter discount and gift card codes at checkout. Here is why a code might not work.',
   'Codes are entered at checkout, in the **Discount or gift code** box under the order summary.

## Discount codes

- One discount code per order.
- Most codes don''t apply to subscriptions, gift subscriptions or equipment on sale. The code''s terms say what''s included.
- Discount codes can''t be added after an order is placed.

## Gift card codes

Gift card codes can be combined with a discount code and used over several orders until the balance runs out. Check your balance in **Account › Billing**.

## Why isn''t my code working?

- **Expired**: check the end date in the email or offer.
- **Minimum not met**: some codes need a minimum order value before shipping.
- **Already used**: welcome codes work once per customer.
- **Typo**: codes aren''t case sensitive, but watch for 0 and O.

Still stuck? Contact us with the code and a screenshot of the message at checkout.',
   'published', now() - interval '80 days', now() - interval '80 days', 702, 70, 15),
  ('orders-shipping', 'holiday-shipping-cutoffs', 'Holiday shipping cut-off dates', 'Last order dates for delivery before the holidays.',
   'To arrive before the holidays, place your order by these dates.

## Cut-off dates

- **Standard shipping**: December 15
- **Express shipping**: December 20
- **Local pickup**: December 23

We''ll confirm the dates once the carriers publish their schedules.',
   'draft', NULL::timestamptz, now() - interval '3 days', 0, 0, 0),
  ('account-billing', 'wholesale-accounts', 'Wholesale accounts for cafés and offices', 'Buying for a café or office? Apply for a wholesale account.',
   'We supply cafés, restaurants and offices with coffee roasted to order.

## Who can apply

Businesses ordering at least 5 kg a month.

## How to apply

Fill in the wholesale form with your business name, address and expected volume. We reply within three business days.',
   'draft', NULL::timestamptz, now() - interval '3 days', 0, 0, 0),
  ('account-billing', 'loyalty-beans-program', 'Loyalty Beans points program', 'The Loyalty Beans program ended. Subscriber perks replace it.',
   'The Loyalty Beans points program has ended. Points could be redeemed until the end of last year.

## What replaces it

Subscribers now get 10% off every bag and free shipping. See [How coffee subscriptions work](/help/articles/how-coffee-subscriptions-work/).',
   'archived', now() - interval '300 days', now() - interval '300 days', 1203, 64, 30)
) AS v("category", "slug", "title", "excerpt", "body", "status", "published_at", "reviewed_at", "views", "helpful", "not_helpful")
JOIN "kb_categories" c ON c."slug" = v."category"
ON CONFLICT ("slug") DO NOTHING;

-- article_count = published articles, as the dashboard keeps it on every write.
UPDATE "kb_categories" c SET "article_count" = (
  SELECT count(*) FROM "kb_articles" a WHERE a."category_id" = c."id" AND a."status" = 'published'
)
WHERE c."slug" IN ('orders-shipping', 'subscriptions', 'brewing-guides', 'equipment-grinders', 'account-billing');

-- Snippets: short answers the assistant may use, never shown publicly. No unique key: WHERE NOT EXISTS.
INSERT INTO "kb_snippets" ("question", "answer", "created_by", "updated_by", "updated_at")
SELECT v."question", v."answer", 0, 0, now()
FROM (VALUES
  ('What are your customer support hours?',
   'Our support team answers messages Monday to Friday, 9 am to 5 pm Eastern time. Messages sent outside those hours are answered the next business day, usually before noon.'),
  ('Do you sell decaf coffee?',
   'Yes. Our Night Owl Decaf is a Colombian coffee decaffeinated with the Swiss Water process, which uses no chemical solvents. It is available whole bean or ground, as a single bag or in a subscription.'),
  ('Are your coffee bags recyclable or compostable?',
   'Our 250 g bags are made from a plant-based film and are certified home compostable once you remove the valve and zip strip, which go in general waste. Our 1 kg bags are recyclable where soft plastics are collected.'),
  ('How do I read the roast date on the bag?',
   'The roast date is printed on the label on the back of every bag in the format DD MMM YYYY. Coffee is at its best between about one and four weeks after that date.'),
  ('What is the minimum order for free shipping?',
   'Standard shipping is free on orders of $35 or more within the US, and on every subscription delivery. Orders to Canada ship free from $75.'),
  ('Do you sell gift cards?',
   'Yes. Digital gift cards from $25 to $200 are sent by email on the date you choose. They never expire and can be used over several orders.'),
  ('How much caffeine is in a cup of your coffee?',
   'A typical 250 ml cup of our regular coffee has roughly 90 to 140 mg of caffeine, depending on the coffee and brew method. A double espresso has about 120 mg. Night Owl Decaf has less than 5 mg per cup.'),
  ('Can I pick up my order from the roastery?',
   'Yes. Choose Local pickup at checkout. Orders are ready the next business day at the roastery shop, open Tuesday to Saturday, 8 am to 3 pm. Bring your order number.'),
  ('Which payment methods do you accept?',
   'We accept Visa, Mastercard, American Express and Discover, plus Apple Pay and Google Pay. Gift card codes can be used at checkout too.'),
  ('Is your coffee organic and fairly traded?',
   'Most of our single origins are certified organic, marked with a leaf on the product page. We buy directly from farms and cooperatives and publish the price we paid per pound for every coffee on its page.')
) AS v("question", "answer")
WHERE NOT EXISTS (SELECT 1 FROM "kb_snippets" s WHERE s."question" = v."question");

-- Search chunks of every PUBLISHED article: one per section, heading "<title> — <section>",
-- plain text (what src/server/kb/chunks.ts builds on publish). Only for articles with none yet.
INSERT INTO "kb_chunks" ("article_id", "position", "heading", "text")
SELECT a."id", v."position", v."heading", v."text"
FROM (VALUES
  ('how-long-does-shipping-take', 0, 'How long does shipping take?',
   'We roast every order fresh, so your coffee leaves our roastery within two business days of the order. Orders placed before 11 am (Eastern) on a weekday usually ship the next business day.'),
  ('how-long-does-shipping-take', 1, 'How long does shipping take? — Delivery options',
   'Option, Delivery time after shipping, Price
Standard, 3–5 business days, Free on orders of $35 or more, otherwise $5.95
Express, 1–2 business days, $12.95
Local pickup, Ready the next business day, Free'),
  ('how-long-does-shipping-take', 2, 'How long does shipping take? — Why does my order take a day to ship?',
   'We don''t keep roasted coffee on a shelf. Each bag is roasted, rested for a few hours so it can release carbon dioxide, then sealed in a valve bag. That short wait is what makes the coffee taste fresh when it arrives.'),
  ('how-long-does-shipping-take', 3, 'How long does shipping take? — Holidays and busy weeks',
   'Around public holidays and during our seasonal sales, roasting can take an extra day. We post any delays on the checkout page before you pay, so you always know what to expect.'),
  ('how-long-does-shipping-take', 4, 'How long does shipping take? — Still waiting?',
   'If your order hasn''t arrived within the time above, check your tracking link first (see Tracking your order). If tracking hasn''t moved for three business days, contact us and we''ll chase the carrier for you.'),
  ('tracking-your-order', 0, 'Tracking your order',
   'As soon as your coffee leaves the roastery we send a shipping confirmation email with a tracking link.'),
  ('tracking-your-order', 1, 'Tracking your order — Where to find your tracking number',
   '1. Open the email with the subject "Your Northwind order is on its way".
2. Select Track my package.
3. Or sign in, open Account › Orders, and select the order: the tracking number is under the delivery address.'),
  ('tracking-your-order', 2, 'Tracking your order — What the statuses mean',
   'Label created: the label is printed and the box is waiting for the carrier''s daily pickup. This can show for up to 24 hours.
In transit: the carrier has the parcel and it''s moving between depots.
Out for delivery: it should arrive today.
Delivered: the carrier scanned it at your address or a safe place.'),
  ('tracking-your-order', 3, 'Tracking your order — Tracking says delivered, but I can''t find it',
   'Check around your door, with neighbours and in your building''s mail room. Carriers sometimes mark a parcel delivered a few hours early. If it still hasn''t turned up by the next day, contact us with your order number and we''ll open a claim with the carrier.'),
  ('tracking-your-order', 4, 'Tracking your order — No tracking email?',
   'Look in your spam or promotions folder. Subscription orders use the same email address as your account, so make sure it''s up to date in Account › Profile.'),
  ('changing-or-cancelling-an-order', 0, 'Changing or cancelling an order',
   'Because we roast to order, there is a short window in which you can change or cancel an order.'),
  ('changing-or-cancelling-an-order', 1, 'Changing or cancelling an order — Before roasting starts',
   'Until your order shows Roasting in Account › Orders, you can:

change the grind size or swap a coffee for another of the same size,
update the delivery address,
add items (we''ll charge the difference),
cancel the whole order for a full refund.

Select the order and choose Edit order. Changes are saved immediately and you''ll get an updated confirmation email.'),
  ('changing-or-cancelling-an-order', 2, 'Changing or cancelling an order — After roasting starts',
   'Once the status is Roasting or Shipped, the coffee has been made for you and we can''t change it. You can still:

ask the carrier to redirect the parcel using the tracking link, or
return unopened equipment within 30 days (see Refund policy).

Roasted coffee can''t be returned for hygiene reasons, but if something is wrong with it, tell us and we''ll make it right.'),
  ('changing-or-cancelling-an-order', 3, 'Changing or cancelling an order — Wrong address on a shipped order?',
   'Contact us as soon as possible with your order number and the correct address. If the carrier hasn''t picked it up yet we can often fix the label.'),
  ('damaged-or-missing-items', 0, 'Damaged or missing items',
   'We pack every box carefully, but occasionally something goes wrong on the way. If an item arrives damaged or is missing, we''ll replace it at no cost.'),
  ('damaged-or-missing-items', 1, 'Damaged or missing items — Report it within 14 days',
   '1. Take a photo of the damaged item and the outside of the box.
2. Contact us with your order number, what''s wrong and the photos.
3. We''ll send a replacement, usually within two business days. You don''t need to return the damaged item.'),
  ('damaged-or-missing-items', 2, 'Damaged or missing items — Missing items',
   'Some orders ship in more than one box, especially when equipment and coffee are ordered together. Check your shipping email: if it lists two tracking numbers, the second box may still be on its way.

If everything has arrived and an item is still missing, let us know and we''ll send it right away.'),
  ('damaged-or-missing-items', 3, 'Damaged or missing items — Coffee that tastes off',
   'If a bag tastes stale, sour or burnt, tell us which coffee it was and the roast date printed on the bag. We''ll send a fresh bag or a different coffee you''d rather try.'),
  ('international-shipping', 0, 'Do you ship internationally?',
   'We currently ship to addresses in the United States and Canada.'),
  ('international-shipping', 1, 'Do you ship internationally? — Canada',
   'Delivery takes 5–8 business days after shipping.
Shipping is a flat $14.95, free on orders of $75 or more.
Prices are charged in US dollars. Your bank converts them at its own rate.
We pay the duties and import taxes, so there is nothing to pay when the parcel arrives.'),
  ('international-shipping', 2, 'Do you ship internationally? — Other countries',
   'We don''t ship elsewhere yet. Many customers abroad send our coffee as a gift to friends in the US instead.'),
  ('international-shipping', 3, 'Do you ship internationally? — Equipment outside the US',
   'Grinders and brewers are sold with US plugs (120 V). If you order electrical equipment for a Canadian address, it works as is: Canada uses the same voltage and plug.'),
  ('how-coffee-subscriptions-work', 0, 'How coffee subscriptions work',
   'A Northwind subscription sends freshly roasted coffee on a schedule you choose. There''s no minimum term, and you can change or cancel it whenever you like.'),
  ('how-coffee-subscriptions-work', 1, 'How coffee subscriptions work — Setting one up',
   '1. Choose a coffee, or Roaster''s choice to get a different single origin each time.
2. Choose a bag size (250 g or 1 kg) and a grind (whole bean, or a grind for your brewer).
3. Choose how often: every 1, 2, 3 or 4 weeks.'),
  ('how-coffee-subscriptions-work', 2, 'How coffee subscriptions work — When you''re charged',
   'You''re charged on the day each order is roasted, never in advance. The date of your next order is always shown in Account › Subscriptions, and we email you three days before so you have time to make changes.'),
  ('how-coffee-subscriptions-work', 3, 'How coffee subscriptions work — Subscriber perks',
   '10% off every subscription bag.
Free standard shipping on every delivery.
Early access to limited coffees.'),
  ('how-coffee-subscriptions-work', 4, 'How coffee subscriptions work — Managing it',
   'Everything is in Account › Subscriptions: pause or skip a delivery, switch coffee or grind, update the address or payment method, or cancel.'),
  ('pause-skip-or-change-delivery-date', 0, 'Pause, skip or change a delivery date',
   'Have too much coffee, or going on holiday? You can adjust your subscription without cancelling it.'),
  ('pause-skip-or-change-delivery-date', 1, 'Pause, skip or change a delivery date — Skip the next delivery',
   '1. Sign in and open Account › Subscriptions.
2. Select Skip next delivery.

The following delivery moves out by one interval. You won''t be charged for the skipped one.'),
  ('pause-skip-or-change-delivery-date', 2, 'Pause, skip or change a delivery date — Move the date',
   'Select Change date and pick any day in the next 60 days. Future deliveries then follow your usual interval from the new date.'),
  ('pause-skip-or-change-delivery-date', 3, 'Pause, skip or change a delivery date — Pause',
   'Select Pause and choose 2 weeks, 1 month, 2 months or 3 months. We''ll email you a week before it starts again. You can resume early at any time with Resume now.'),
  ('pause-skip-or-change-delivery-date', 4, 'Pause, skip or change a delivery date — Deadlines',
   'Changes must be made before 11 am (Eastern) the day before your order is roasted. After that, the order is already in the roasting queue and will ship as planned.'),
  ('change-coffee-or-grind-in-subscription', 0, 'Change the coffee or grind in your subscription',
   'You can change what''s in your subscription at any time. Changes apply from the next order that hasn''t started roasting.'),
  ('change-coffee-or-grind-in-subscription', 1, 'Change the coffee or grind in your subscription — Switch coffee',
   '1. Open Account › Subscriptions and select Edit.
2. Under Coffee, choose a new one. Prices update straight away.
3. Select Save.

Not sure what to pick? Roaster''s choice rotates through our current single origins so you get something new every delivery.'),
  ('change-coffee-or-grind-in-subscription', 2, 'Change the coffee or grind in your subscription — Change the grind',
   'Choose whole bean if you have a grinder: it keeps the coffee fresh for longer. Otherwise pick the grind that matches your brewer:

Espresso: fine, like table salt.
Pour-over / filter: medium, like sand.
French press / cold brew: coarse, like sea salt.

See Choosing the right grind size for more detail.'),
  ('change-coffee-or-grind-in-subscription', 3, 'Change the coffee or grind in your subscription — Add a second coffee',
   'Select Add a coffee to include another bag in the same delivery. Both bags ship together and share free shipping.'),
  ('cancel-your-subscription', 0, 'Cancel your subscription',
   'You can cancel your subscription at any time, with no cancellation fee.'),
  ('cancel-your-subscription', 1, 'Cancel your subscription — How to cancel',
   '1. Sign in and open Account › Subscriptions.
2. Select Cancel subscription.
3. Tell us why, if you''d like (it''s optional and helps us improve), then confirm.

You''ll get an email confirming the cancellation.'),
  ('cancel-your-subscription', 2, 'Cancel your subscription — What happens to an upcoming order?',
   'If the next order hasn''t started roasting, it''s cancelled and you won''t be charged.
If it''s already roasting or shipped, it will still arrive and is charged as usual.'),
  ('cancel-your-subscription', 3, 'Cancel your subscription — Would a pause work instead?',
   'If you just have too much coffee or are travelling, you can pause for up to three months and keep your subscriber discount.'),
  ('cancel-your-subscription', 4, 'Cancel your subscription — Restarting later',
   'Cancelled subscriptions stay in your account. Select Restart at any time to pick up where you left off with the same coffee and settings.'),
  ('subscription-gift-options', 0, 'Giving a coffee subscription as a gift',
   'A gift subscription is a prepaid run of deliveries for someone else. It ends on its own, so the recipient never has to cancel anything.'),
  ('subscription-gift-options', 1, 'Giving a coffee subscription as a gift — Choosing a gift',
   'Length: 3, 6 or 12 deliveries.
Frequency: every 2 or 4 weeks.
Coffee: Roaster''s choice, or one coffee for every delivery.
Grind: whole bean is the safest choice if you don''t know their brewer.'),
  ('subscription-gift-options', 2, 'Giving a coffee subscription as a gift — Personal message and start date',
   'Add a message at checkout: we print it on a card in the first box. Pick any start date in the next six months, which is handy for birthdays and holidays.'),
  ('subscription-gift-options', 3, 'Giving a coffee subscription as a gift — Can the recipient change it?',
   'Yes. The recipient gets an email with a link to claim the gift, then can change the grind, delivery address and dates. They can''t see what you paid.'),
  ('subscription-gift-options', 4, 'Giving a coffee subscription as a gift — After the last delivery',
   'We email the recipient to let them know it has ended and offer them a regular subscription. Nothing renews automatically, and you''re never charged again.'),
  ('pour-over-brewing-guide', 0, 'Pour-over brewing guide',
   'Pour-over gives a clean, bright cup that shows off a coffee''s origin. This recipe works with most cone drippers.'),
  ('pour-over-brewing-guide', 1, 'Pour-over brewing guide — What you need',
   '15 g of coffee, ground medium (like sand)
250 g of water just off the boil, about 94 °C
A cone dripper, a paper filter, a scale and a kettle'),
  ('pour-over-brewing-guide', 2, 'Pour-over brewing guide — Recipe',
   '1. Rinse the filter with hot water and pour that water away. This removes paper taste and warms the dripper.
2. Add the coffee and shake it level.
3. Bloom: start a timer and pour 40 g of water, just enough to wet all the grounds. Wait 30 seconds.
4. Pour slowly in small circles to 150 g by 1:00.
5. Finish pouring to 250 g by 1:45.
6. Let it drain. Total time should be 2:45 to 3:30.'),
  ('pour-over-brewing-guide', 3, 'Pour-over brewing guide — Adjusting the taste',
   'Sour or thin, drains too fast: grind finer.
Bitter or dry, drains too slowly: grind coarser.
Too strong or too weak: change the coffee by 1 g, not the water.

Change one thing at a time and write down what you did. That''s the fastest way to your perfect cup.'),
  ('french-press-brewing-guide', 0, 'French press brewing guide',
   'The French press makes a rich, full-bodied cup and needs no filters. It''s very forgiving, which makes it a great place to start.'),
  ('french-press-brewing-guide', 1, 'French press brewing guide — What you need',
   '30 g of coffee, ground coarse (like sea salt)
450 g of water at about 94 °C
A French press, a spoon and a timer'),
  ('french-press-brewing-guide', 2, 'French press brewing guide — Recipe',
   '1. Warm the press with hot water, then pour it out.
2. Add the coffee and start a timer.
3. Pour all 450 g of water, making sure every ground is wet.
4. At 4:00, stir the crust on top gently and scoop off the foam.
5. Put the lid on and press the plunger down slowly, about 20 seconds.
6. Pour it all out straight away. Coffee left on the grounds keeps brewing and turns bitter.'),
  ('french-press-brewing-guide', 3, 'French press brewing guide — Less sludge in the cup',
   'Use a coarser grind: fine particles pass through the mesh.
Wait five minutes after step 4 before pressing so fines settle.
Don''t push the plunger all the way to the bottom.'),
  ('french-press-brewing-guide', 4, 'French press brewing guide — Cleaning',
   'Take the plunger apart once a week and wash the mesh with warm soapy water. Old coffee oils trapped in the mesh make every cup taste stale.'),
  ('espresso-dial-in-basics', 0, 'Dialling in espresso',
   '"Dialling in" means adjusting your grinder until a coffee tastes its best as espresso. Every new bag needs a few shots to get there.'),
  ('espresso-dial-in-basics', 1, 'Dialling in espresso — Starting recipe',
   'Dose: 18 g of finely ground coffee in a double basket
Yield: 36 g of espresso in the cup (a 1:2 ratio)
Time: 25 to 30 seconds from pressing the button

Weigh both the dose and the yield. Guessing by volume is the most common reason espresso tastes different every day.'),
  ('espresso-dial-in-basics', 2, 'Dialling in espresso — Adjust the grind, one step at a time',
   'Runs too fast (under 25 s), tastes sour or salty: grind finer.
Runs too slow (over 32 s), tastes bitter or harsh: grind coarser.
Tastes good but too intense: increase the yield to 40 g.'),
  ('espresso-dial-in-basics', 3, 'Dialling in espresso — Good habits',
   '1. Distribute the grounds evenly before tamping.
2. Tamp level and firmly; the exact pressure matters less than being consistent.
3. Flush the group head for two seconds before each shot.
4. Use beans 7 to 28 days after the roast date. Very fresh beans can spurt and taste sharp.

Our espresso blends list a suggested recipe on the bag. Use that as your starting point.'),
  ('cold-brew-at-home', 0, 'Making cold brew at home',
   'Cold brew is smooth, low in acidity and easy to make in a jar. It''s brewed as a concentrate, so a batch lasts all week.'),
  ('cold-brew-at-home', 1, 'Making cold brew at home — What you need',
   '100 g of coffee, ground coarse
1 litre of cold, filtered water
A large jar, and a paper filter or fine cloth'),
  ('cold-brew-at-home', 2, 'Making cold brew at home — Recipe',
   '1. Put the coffee in the jar, add the water and stir until all the grounds are wet.
2. Cover and leave it in the fridge for 16 to 18 hours.
3. Strain through the filter. Take your time: squeezing the grounds makes it bitter.
4. Keep the concentrate in a sealed bottle in the fridge for up to 7 days.'),
  ('cold-brew-at-home', 3, 'Making cold brew at home — Serving',
   'Mix one part concentrate with one part water or milk, over ice. Adjust to taste: some people like it stronger.'),
  ('cold-brew-at-home', 4, 'Making cold brew at home — Which coffee?',
   'Chocolatey, nutty coffees such as our Harbor Blend make a classic cold brew. Fruity single origins work too and taste like iced tea with a coffee finish.'),
  ('storing-coffee-beans-fresh', 0, 'How to keep your coffee fresh',
   'Coffee is at its best between about one and four weeks after its roast date, printed on every bag.'),
  ('storing-coffee-beans-fresh', 1, 'How to keep your coffee fresh — Store it well',
   'Keep it in our bag. The one-way valve lets gas out without letting air in. Squeeze out the air and close the zip after each use.
Cool, dark and dry. A cupboard away from the stove is ideal.
Not in the fridge. Beans absorb moisture and smells from other food.'),
  ('storing-coffee-beans-fresh', 2, 'How to keep your coffee fresh — Freezing',
   'If you bought more than you''ll use in a month, freeze it in small airtight portions, one week''s worth each. Take out one portion at a time and let it reach room temperature before opening so no condensation forms. Never refreeze.'),
  ('storing-coffee-beans-fresh', 3, 'How to keep your coffee fresh — Whole bean or ground?',
   'Ground coffee goes stale in days, whole beans in weeks. If you don''t have a grinder yet, order smaller bags more often, which a subscription makes easy.'),
  ('choosing-the-right-grind-size', 0, 'Choosing the right grind size',
   'Grind size controls how fast water extracts flavour from coffee. Finer grinds extract faster; coarser grinds extract slower. Match the grind to your brewer.'),
  ('choosing-the-right-grind-size', 1, 'Choosing the right grind size — Grind size chart',
   'Brewer, Grind, Looks like, Setting on the Northwind Burr Grinder
Espresso, Fine, Table salt, 2–6
Moka pot, Medium-fine, Fine sand, 8–10
Pour-over, drip, Medium, Sand, 12–18
French press, Coarse, Sea salt, 24–28
Cold brew, Extra coarse, Cracked pepper, 30–32'),
  ('choosing-the-right-grind-size', 2, 'Choosing the right grind size — Signs the grind is wrong',
   'Sour, thin, watery: too coarse. Go finer.
Bitter, dry, harsh: too fine. Go coarser.
Muddy cup or clogged filter: too fine, or a grinder making lots of dust.'),
  ('choosing-the-right-grind-size', 3, 'Choosing the right grind size — Burr or blade?',
   'A burr grinder crushes coffee to an even size, so every particle brews at the same rate. A blade grinder chops unevenly and makes both dust and boulders, which taste bitter and sour at once. If you can, choose burrs.'),
  ('cleaning-your-burr-grinder', 0, 'Cleaning your burr grinder',
   'Coffee oils and fine particles build up inside every grinder. Over time they go stale and change the grind size. A quick clean keeps your coffee tasting right.'),
  ('cleaning-your-burr-grinder', 1, 'Cleaning your burr grinder — Every two weeks: quick clean',
   '1. Unplug the grinder and empty the hopper.
2. Run it empty for a few seconds to clear the chute.
3. Brush the chute and the outlet with the brush supplied.'),
  ('cleaning-your-burr-grinder', 2, 'Cleaning your burr grinder — Every three months: deep clean',
   '1. Unplug the grinder and empty the hopper.
2. Turn the upper burr anticlockwise past the coarsest setting and lift it out.
3. Brush both burrs and the chamber. Use a vacuum for loose grounds.
4. Wipe the hopper with a damp cloth and let it dry completely.
5. Put the upper burr back and turn it to your usual setting.'),
  ('cleaning-your-burr-grinder', 3, 'Cleaning your burr grinder — What not to do',
   'Never wash the burrs with water. They can rust.
Don''t grind rice to clean it: it can damage the motor and voids the warranty.
Grinder cleaning tablets are fine; follow the instructions on the pack.

After a deep clean, the first dose may taste a little different. Grind and discard about 10 g of coffee before your first brew.'),
  ('grinder-not-grinding-troubleshooting', 0, 'My grinder stopped grinding',
   'Most grinder problems are caused by a blockage or a safety switch. Try these checks first. Unplug the grinder before you touch the burrs.'),
  ('grinder-not-grinding-troubleshooting', 1, 'My grinder stopped grinding — The motor doesn''t start',
   'Check the hopper is clicked fully into place. The grinder has a safety switch and won''t run without it.
Check the grounds bin is pushed all the way in.
Try another outlet.
If it ran for a long time, the motor may have overheated. Leave it for 30 minutes and try again.'),
  ('grinder-not-grinding-troubleshooting', 2, 'My grinder stopped grinding — The motor runs but no coffee comes out',
   '1. Empty the hopper.
2. Remove the upper burr (see Cleaning your burr grinder).
3. Look for a stuck bean, a stone or packed grounds in the chute, and brush it clear.
4. Reassemble and try again with a small amount of coffee.

Very fine espresso settings with oily, dark-roast beans can pack the chute. Grind a little coarser or clean more often.'),
  ('grinder-not-grinding-troubleshooting', 3, 'My grinder stopped grinding — Loud grinding or squealing',
   'Stop using it straight away: a stone may have reached the burrs. Contact us with your order number. This is covered by the warranty.'),
  ('equipment-warranty', 0, 'Equipment warranty',
   'All grinders, kettles and brewers bought from Northwind Coffee Co. come with a two-year warranty from the delivery date.'),
  ('equipment-warranty', 1, 'Equipment warranty — What''s covered',
   'Faults in materials or manufacturing.
Motors, switches and electronics that stop working with normal home use.
Burrs damaged by a stone found in our coffee.'),
  ('equipment-warranty', 2, 'Equipment warranty — What isn''t covered',
   'Wear parts such as burrs after normal use, gaskets and filters.
Damage from dropping, water, or grinding things other than coffee.
Commercial use.'),
  ('equipment-warranty', 3, 'Equipment warranty — Making a claim',
   '1. Contact us with your order number, a short description and, if you can, a photo or short video of the problem.
2. We''ll try to fix it with you first: many issues are solved in a few minutes.
3. If it can''t be fixed, we''ll send a prepaid return label and ship a repaired or replacement unit, usually within five business days of receiving it.

You don''t need to register your equipment. Your order is your proof of purchase. Bought it as a gift? Ask the person who ordered it for the order number, or contact us with their name and the delivery address.'),
  ('descaling-your-espresso-machine', 0, 'Descaling your espresso machine or kettle',
   'Minerals in tap water slowly build up as limescale inside kettles and espresso machines. It makes heating slower and less accurate and can make coffee taste flat.'),
  ('descaling-your-espresso-machine', 1, 'Descaling your espresso machine or kettle — How often',
   'Hard water (white marks on taps and glasses): every month.
Medium water: every two months.
Soft or filtered water: every three months.'),
  ('descaling-your-espresso-machine', 2, 'Descaling your espresso machine or kettle — Descaling an espresso machine',
   '1. Empty the water tank and fill it with descaling solution mixed as the pack says.
2. Run half the tank through the steam wand and half through the group head, with a jug underneath.
3. Leave it to stand for 15 minutes.
4. Rinse the tank, fill it with fresh water and run a full tank through both again.'),
  ('descaling-your-espresso-machine', 3, 'Descaling your espresso machine or kettle — Descaling a kettle',
   'Fill it with a mix of one part white vinegar or citric acid solution and three parts water, boil, leave for an hour, then rinse and boil fresh water twice.'),
  ('descaling-your-espresso-machine', 4, 'Descaling your espresso machine or kettle — Prevent it',
   'Using filtered water reduces scale a lot and usually makes better coffee too. Avoid distilled water in espresso machines: some minerals are needed for the sensors and for flavour.'),
  ('update-payment-method', 0, 'Update your payment method',
   'Your saved card is used for subscription orders and for one-click checkout.'),
  ('update-payment-method', 1, 'Update your payment method — Change your card',
   '1. Sign in and open Account › Billing.
2. Select Update card and enter the new details.
3. Select Save. The new card is used from your next charge.

We never see or store your full card number: it''s held securely by our payment provider.'),
  ('update-payment-method', 2, 'Update your payment method — Which payment methods do you accept?',
   'Visa, Mastercard, American Express and Discover, plus Apple Pay and Google Pay at checkout.'),
  ('update-payment-method', 3, 'Update your payment method — If a payment fails',
   'If a subscription payment is declined, we email you and try again after two days and after five days. Your order waits until the payment goes through, so the coffee is still roasted fresh. After three failed attempts we pause the subscription; update your card and select Resume to restart it.

Common reasons for a decline are an expired card, a new card number after a replacement, or your bank blocking an unusual charge.'),
  ('why-was-i-charged', 0, 'Why was I charged?',
   'If you see a charge you don''t recognise, it is usually one of the following.'),
  ('why-was-i-charged', 1, 'Why was I charged? — Your subscription',
   'Subscription orders are charged on the day they''re roasted. Check Account › Subscriptions for the date of the last order. The charge shows on your statement as NORTHWIND COFFEE.'),
  ('why-was-i-charged', 2, 'Why was I charged? — A temporary hold',
   'When you place an order, your bank may show a pending authorisation for the amount. If you change or cancel the order before roasting, the hold disappears within 3–7 business days, depending on your bank. It is not a second charge.'),
  ('why-was-i-charged', 3, 'Why was I charged? — Split shipments',
   'If part of an order shipped separately, you may see two charges that add up to the order total.'),
  ('why-was-i-charged', 4, 'Why was I charged? — Taxes and shipping',
   'Sales tax depends on your delivery address and is added at checkout. Orders under $35 include $5.95 standard shipping.'),
  ('why-was-i-charged', 5, 'Why was I charged? — Still not sure?',
   'Contact us with the date and amount from your statement (never your full card number) and we''ll look it up. If we charged you by mistake, we''ll refund it in full.'),
  ('refund-policy', 0, 'Refund policy',
   'We want you to love what you order. Here''s how refunds work.'),
  ('refund-policy', 1, 'Refund policy — Coffee',
   'Roasted coffee can''t be returned once it has shipped. If a bag is damaged, missing or not as described, we''ll replace it or refund it, whichever you prefer. Contact us within 14 days of delivery.'),
  ('refund-policy', 2, 'Refund policy — Equipment',
   'Unused equipment in its original packaging can be returned within 30 days of delivery for a full refund.
We send a prepaid return label for faulty items. For change-of-mind returns, return shipping is $7.95, deducted from the refund.
Faults after 30 days are covered by the two-year warranty.'),
  ('refund-policy', 3, 'Refund policy — Cancelled orders',
   'Orders cancelled before roasting are refunded in full straight away.'),
  ('refund-policy', 4, 'Refund policy — How long refunds take',
   'We issue refunds within two business days of approving them. Your bank then takes 3–10 business days to show it on your statement. Refunds always go back to the original payment method.'),
  ('reset-your-password', 0, 'Reset your password',
   'If you can''t remember your password, you can set a new one in a couple of minutes.'),
  ('reset-your-password', 1, 'Reset your password — Reset it',
   '1. Go to the sign-in page and select Forgot password?
2. Enter the email address on your account.
3. Open the email from us and select the link. It works for one hour.
4. Choose a new password.

For your security, we never send passwords by email, and our support team will never ask you for yours.'),
  ('reset-your-password', 2, 'Reset your password — Didn''t get the email?',
   'Check your spam or promotions folder.
Make sure you used the address you signed up with. Gift recipients use the address the gift was sent to.
Wait a few minutes and try again: requests are limited to protect your account.'),
  ('reset-your-password', 3, 'Reset your password — Signed in with an old email?',
   'If you no longer have access to that inbox, contact us from your new address with an order number and the delivery postcode, and we''ll help you move your account.'),
  ('apply-a-discount-code', 0, 'Using a discount or gift code',
   'Codes are entered at checkout, in the Discount or gift code box under the order summary.'),
  ('apply-a-discount-code', 1, 'Using a discount or gift code — Discount codes',
   'One discount code per order.
Most codes don''t apply to subscriptions, gift subscriptions or equipment on sale. The code''s terms say what''s included.
Discount codes can''t be added after an order is placed.'),
  ('apply-a-discount-code', 2, 'Using a discount or gift code — Gift card codes',
   'Gift card codes can be combined with a discount code and used over several orders until the balance runs out. Check your balance in Account › Billing.'),
  ('apply-a-discount-code', 3, 'Using a discount or gift code — Why isn''t my code working?',
   'Expired: check the end date in the email or offer.
Minimum not met: some codes need a minimum order value before shipping.
Already used: welcome codes work once per customer.
Typo: codes aren''t case sensitive, but watch for 0 and O.

Still stuck? Contact us with the code and a screenshot of the message at checkout.')
) AS v("slug", "position", "heading", "text")
JOIN "kb_articles" a ON a."slug" = v."slug" AND a."status" = 'published'
WHERE NOT EXISTS (SELECT 1 FROM "kb_chunks" k WHERE k."article_id" = a."id");

-- One chunk per snippet (heading = question, text = answer).
INSERT INTO "kb_chunks" ("snippet_id", "position", "heading", "text")
SELECT s."id", 0, s."question", s."answer"
FROM "kb_snippets" s
WHERE s."question" IN ('What are your customer support hours?', 'Do you sell decaf coffee?', 'Are your coffee bags recyclable or compostable?', 'How do I read the roast date on the bag?', 'What is the minimum order for free shipping?', 'Do you sell gift cards?', 'How much caffeine is in a cup of your coffee?', 'Can I pick up my order from the roastery?', 'Which payment methods do you accept?', 'Is your coffee organic and fairly traded?')
  AND NOT EXISTS (SELECT 1 FROM "kb_chunks" k WHERE k."snippet_id" = s."id");

-- Quick replies the assistant offers as buttons.
INSERT INTO "helpdesk_quick_replies" ("label", "position", "updated_at")
SELECT v."label", v."position", now()
FROM (VALUES
  ('Where is my order?', 0),
  ('Change my subscription', 1),
  ('Help me brew better coffee', 2)
) AS v("label", "position")
WHERE NOT EXISTS (SELECT 1 FROM "helpdesk_quick_replies" r WHERE r."label" = v."label");

-- Topics the assistant always hands to a person.
INSERT INTO "helpdesk_human_topics" ("keyword", "updated_at") VALUES
  ('refund', now()),
  ('legal', now()),
  ('allergy', now())
ON CONFLICT ("keyword") DO NOTHING;

COMMIT;
