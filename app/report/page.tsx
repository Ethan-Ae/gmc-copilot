import ReportClient from "./ReportClient";
import { getShopifyAppStoreUrl } from "../../lib/shopify";

export default function ReportPage() {
  return <ReportClient appStoreUrl={getShopifyAppStoreUrl()} />;
}
