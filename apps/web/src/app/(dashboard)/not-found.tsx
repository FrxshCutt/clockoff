import { SearchX } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";

/** `notFound()` inside a dashboard page (e.g. an unknown id): keeps the shell around the message. */
export default function DashboardNotFound() {
  return (
    <div className="py-8">
      <EmptyState
        icon={SearchX}
        title="We couldn't find that"
        description="It may have been deleted, or the link may be wrong."
        action={
          <Button asChild>
            <Link href={ROUTES.overview}>Go to overview</Link>
          </Button>
        }
      />
    </div>
  );
}
