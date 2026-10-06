"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { FaqItem } from "./help-content";

/** Single-open accordion of questions and answers (keyboard navigable via Radix). */
export function FaqAccordion({
  items,
  className,
}: {
  items: readonly FaqItem[];
  className?: string;
}) {
  return (
    <Accordion type="single" collapsible className={className}>
      {items.map((item) => (
        <AccordionItem key={item.id} value={item.id}>
          <AccordionTrigger className="text-left text-base">{item.question}</AccordionTrigger>
          <AccordionContent className="text-muted-foreground space-y-3 text-sm leading-relaxed">
            <p>{item.answer}</p>
            {item.href && item.linkLabel ? (
              <Link
                href={item.href}
                className="text-primary inline-flex items-center gap-1 font-medium hover:underline"
              >
                {item.linkLabel}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
