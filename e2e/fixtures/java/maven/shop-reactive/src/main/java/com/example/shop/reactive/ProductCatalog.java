package com.example.shop.reactive;

import com.example.shop.common.Money;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Component
public class ProductCatalog {
  public Flux<ProductView> all() {
    return Flux.just(new ProductView("A-1", "Mug", Money.of("9.99", "EUR")));
  }

  public Mono<ProductView> one(String sku) {
    return all().filter(p -> p.sku().equals(sku)).next();
  }
}
