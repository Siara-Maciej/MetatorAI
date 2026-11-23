package com.example.shop.api;

import com.example.shop.api.dto.CreateOrderRequest;
import com.example.shop.api.dto.OrderDto;
import com.example.shop.domain.Order;
import com.example.shop.domain.OrderStatus;
import com.example.shop.domain.service.OrderService;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  private final OrderService orderService;
  private final PricingService pricing;

  public OrderController(OrderService orderService, PricingService pricing) {
    this.orderService = orderService;
    this.pricing = pricing;
  }

  @GetMapping("/{id}")
  public ResponseEntity<OrderDto> get(@PathVariable Long id) {
    return orderService.find(id).map(this::toDto).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
  }

  @GetMapping
  public List<OrderDto> list(@RequestParam(required = false) OrderStatus status) {
    return orderService.byStatus(status).stream().map(this::toDto).toList();
  }

  @PostMapping(consumes = "application/json")
  public ResponseEntity<OrderDto> create(
      @RequestBody CreateOrderRequest request, @RequestHeader("X-Request-Id") String requestId) {
    return ResponseEntity.accepted().build();
  }

  @DeleteMapping("/{id}")
  public void cancel(@PathVariable("id") Long orderId) {}

  private OrderDto toDto(Order order) {
    return new OrderDto(order.getId(), order.getStatus().name(), pricing.format(order.getTotal()));
  }
}
