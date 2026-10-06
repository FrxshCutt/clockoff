"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { getBreadcrumbs } from "@/config/navigation";
import { cn } from "@/lib/utils";
import { useBreadcrumbLabels } from "./breadcrumb-store";

/** Breadcrumbs derived from the route segments. On small screens only the last two levels show. */
export function Breadcrumbs({ className }: { className?: string }) {
  const pathname = usePathname() ?? "/";
  const labels = useBreadcrumbLabels();
  const crumbs = getBreadcrumbs(pathname, labels);
  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb className={cn("min-w-0", className)}>
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          const hiddenOnMobile = index < crumbs.length - 2;
          return (
            <Fragment key={crumb.href}>
              {index > 0 ? (
                // On mobile the first visible crumb is the second-to-last, so its leading separator hides too.
                <BreadcrumbSeparator className={cn(index <= crumbs.length - 2 && "hidden md:block")} />
              ) : null}
              <BreadcrumbItem className={cn("min-w-0", hiddenOnMobile && "hidden md:inline-flex")}>
                {isLast ? (
                  <BreadcrumbPage className="truncate font-medium">{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href} className="truncate">
                      {crumb.label}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
