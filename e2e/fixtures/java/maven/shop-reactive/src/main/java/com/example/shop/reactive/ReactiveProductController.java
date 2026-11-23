package com.example.shop.reactive;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/reactive/products")
public class ReactiveProductController {
  private final ProductCatalog catalog;

  public ReactiveProductController(ProductCatalog catalog) {
    this.catalog = catalog;
  }

  @GetMapping
  public Flux<ProductView> all() {
    return catalog.all();
  }

  @GetMapping("/{sku}")
  public Mono<ProductView> one(@PathVariable String sku) {
    return catalog.one(sku);
  }
}
