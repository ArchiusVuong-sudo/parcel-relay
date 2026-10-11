import { Layout } from './components/Layout';
import { useRoute } from './lib/router';
import { InboxPage } from './pages/Inbox';
import { MessagesPage } from './pages/Messages';
import { OrdersPage } from './pages/Orders';
import { OverviewPage } from './pages/Overview';
import { ReviewPage } from './pages/Review';
import { SuppliersPage } from './pages/Suppliers';
import { UploadsPage } from './pages/Uploads';

export function App() {
  const { page, id } = useRoute();
  return (
    <Layout page={page}>
      {page === 'inbox' ? <InboxPage id={id} /> : null}
      {page === 'orders' ? <OrdersPage id={id} /> : null}
      {page === 'uploads' ? <UploadsPage /> : null}
      {page === 'review' ? <ReviewPage /> : null}
      {page === 'suppliers' ? <SuppliersPage /> : null}
      {page === 'messages' ? <MessagesPage /> : null}
      {!['inbox', 'orders', 'uploads', 'review', 'suppliers', 'messages'].includes(page) ? <OverviewPage /> : null}
    </Layout>
  );
}
