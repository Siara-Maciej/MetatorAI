package com.example.shop.api.jobs;

import com.example.shop.api.dto.OrderPlaced;
import java.time.Clock;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class ReportJob {
  private final Clock clock;

  public ReportJob(Clock clock) {
    this.clock = clock;
  }

  @Scheduled(cron = "0 0 2 * * *")
  public void nightly() {
    System.out.println("report at " + clock.instant());
  }

  @EventListener
  public void onOrderPlaced(OrderPlaced event) {
    System.out.println("order " + event.orderId());
  }
}
