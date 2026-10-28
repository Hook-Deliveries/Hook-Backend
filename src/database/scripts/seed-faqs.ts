import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Faq } from '@models/platform/faq.model';
import { nextPublicId } from '@modules/platform/public-id.service';

// One-off dummy content for /help; safe to re-run — skips any question already present.
const DUMMY_FAQS: Array<{ question: string; answer: string }> = [
  { question: 'Where is my order?', answer: 'Open Orders in the Hook app and tap the order for live status. Delivery times shown at checkout are estimates and can shift with traffic or stock changes.' },
  { question: 'How do refunds work?', answer: 'Refunds are issued to the original payment method or as Hook credit, depending on the order. Most refunds are processed within 3-5 business days once approved.' },
  { question: 'How do I change or cancel an order?', answer: 'Orders can be changed or cancelled before a Market Associate confirms sourcing. Contact support with your order number as soon as possible.' },
  { question: 'How do I delete my account?', answer: 'Go to Profile > Delete account in the Hook app. You can cancel the request any time during the cooling-off period before it takes effect.' },
  { question: 'What payment methods does Hook accept?', answer: 'Hook accepts card payments, bank transfer, and Pay on Delivery in eligible states. You can also pay with Hook credit earned from past orders and referrals.' },
  { question: 'How do I become a Hook Partner or Market Associate?', answer: 'Reach out to support with your name, phone number, and the state you operate in — our operations team will follow up with next steps.' },
];

async function main() {
  await connectDatabase();
  let created = 0;
  for (const [index, faq] of DUMMY_FAQS.entries()) {
    const exists = await Faq.exists({ question: faq.question });
    if (exists) {
      console.log(`  skip — "${faq.question}" already exists`);
      continue;
    }
    await Faq.create({
      publicId: await nextPublicId('faq'),
      question: faq.question,
      answer: faq.answer,
      order: index,
      isActive: true,
    });
    created += 1;
    console.log(`  added — "${faq.question}"`);
  }
  console.log(`\n${created} of ${DUMMY_FAQS.length} FAQs added.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
